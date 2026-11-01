import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CONFIG_DIR_NAME, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getSessionCatalogueRoot, getSessionDirectoryOverride } = await jiti.import("./session-storage.ts");
const { listAllSessions, resolveSessionPath, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const { checkSessionMembership, resetSessionScanIndexForTests } = await jiti.import("./session-list-scanner.ts");
const { GET: detail } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { startRpcSession } = await jiti.import("./rpc-manager.ts");

function fixture(t) {
  const previous = new Map(["NEKO_PI_HOME", "NEKO_PI_SESSION_DIR", "PI_OFFLINE"].map((key) => [key, process.env[key]]));
  const root = mkdtempSync(join(tmpdir(), "neko-web-storage-"));
  const home = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  process.env.NEKO_PI_HOME = home;
  process.env.PI_OFFLINE = "1";
  delete process.env.NEKO_PI_SESSION_DIR;
  resetSessionScanIndexForTests();
  invalidateSessionListCache();
  t.after(() => {
    resetSessionScanIndexForTests();
    invalidateSessionListCache();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, cwd };
}

function writeSession(cwd, sessionDir, text = "native transcript") {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage("native answer"));
  return manager;
}

test("session storage follows native environment and project/global settings precedence", (t) => {
  const { root, home, cwd } = fixture(t);
  assert.equal(getSessionDirectoryOverride(), undefined);
  assert.equal(getSessionCatalogueRoot(), join(home, "sessions"));
  const globalDir = join(root, "global-sessions");
  const projectDir = join(root, "project-sessions");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ sessionDir: globalDir }));
  mkdirSync(join(cwd, CONFIG_DIR_NAME));
  writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ sessionDir: projectDir }));
  assert.equal(getSessionCatalogueRoot(), globalDir);
  assert.equal(getSessionDirectoryOverride(cwd), projectDir);
  process.env.NEKO_PI_SESSION_DIR = join(root, "override");
  assert.equal(getSessionDirectoryOverride(cwd), process.env.NEKO_PI_SESSION_DIR);
  assert.equal(getSessionCatalogueRoot(), process.env.NEKO_PI_SESSION_DIR);
});

for (const override of ["environment", "settings"]) test(`Web lists and reads native flat sessions selected by ${override}`, async (t) => {
  const { root, home, cwd } = fixture(t);
  const directory = join(root, "external-sessions");
  if (override === "environment") process.env.NEKO_PI_SESSION_DIR = directory;
  else writeFileSync(join(home, "settings.json"), JSON.stringify({ sessionDir: directory }));
  const manager = writeSession(cwd, directory);
  writeSession(cwd, join(directory, "unrelated-nested"), "not in this native catalogue");
  const native = await SessionManager.listAll(directory);
  const web = await listAllSessions({ force: true });
  assert.deepEqual(web.map((session) => session.id), native.map((session) => session.id));
  assert.equal(web[0].firstMessage, "native transcript");
  globalThis.__piSessionPathCache = undefined;
  globalThis.__piPathToSessionIdCache = undefined;
  assert.equal(await resolveSessionPath(manager.getSessionId()), manager.getSessionFile());
  const response = await detail(new Request(`http://test/api/sessions/${manager.getSessionId()}`), {
    params: Promise.resolve({ id: manager.getSessionId() }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.context.messages[0].content, "native transcript");
  assert.equal(data.context.messages[1].content[0].text, "native answer");
  assert.equal(data.filePath, manager.getSessionFile());
  let changed = false;
  writeSession(cwd, directory, "later external session");
  await checkSessionMembership(directory, () => { changed = true; }, 1_000_000);
  assert.equal(changed, true);
});

test("Web creates its session directly in the native configured directory", async (t) => {
  const { root, cwd } = fixture(t);
  const directory = join(root, "flat");
  process.env.NEKO_PI_SESSION_DIR = directory;
  const { session: wrapper } = await startRpcSession(`__new__${Date.now()}`, "", cwd, { toolNames: [] });
  try {
    wrapper.inner.sessionManager.appendMessage({ role: "user", content: "created through Web", timestamp: Date.now() });
    assert.equal(dirname(wrapper.sessionFile), directory);
    const native = SessionManager.open(wrapper.sessionFile);
    assert.equal(native.getCwd(), cwd);
    assert.equal(native.getSessionId(), wrapper.sessionId);
    assert.deepEqual(native.getEntries(), wrapper.inner.sessionManager.getEntries());
  } finally {
    await wrapper.shutdown();
  }
});
