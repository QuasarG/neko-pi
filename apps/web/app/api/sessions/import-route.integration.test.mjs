import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { POST } = await jiti.import("./[id]/import/route.ts");
const { resetSessionScanIndexForTests } = await jiti.import("../../../lib/session-list-scanner.ts");
const { invalidateSessionListCache, listAllSessions } = await jiti.import("../../../lib/session-reader.ts");

test("session import stores the source JSONL in the current native project session directory", async (t) => {
  const previousHome = process.env.NEKO_PI_HOME;
  const root = mkdtempSync(join(tmpdir(), "neko-web-import-"));
  const home = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  process.env.NEKO_PI_HOME = home;
  resetSessionScanIndexForTests();
  invalidateSessionListCache();
  t.after(() => {
    resetSessionScanIndexForTests();
    invalidateSessionListCache();
    if (previousHome === undefined) delete process.env.NEKO_PI_HOME;
    else process.env.NEKO_PI_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  const active = SessionManager.create(cwd);
  active.appendMessage({ role: "user", content: "active", timestamp: Date.now() });
  const sourceDir = join(root, "external");
  mkdirSync(sourceDir);
  const source = SessionManager.create(cwd, sourceDir);
  source.appendMessage({ role: "user", content: "imported body", timestamp: Date.now() });
  const sourcePath = source.getSessionFile();
  assert.ok(sourcePath);

  const form = new FormData();
  form.set("session", new File([readFileSync(sourcePath)], "backup.jsonl", { type: "application/x-ndjson" }));
  const request = new Request(`http://127.0.0.1/api/sessions/${active.getSessionId()}/import`, {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "sec-fetch-site": "same-origin" },
    body: form,
  });
  const response = await POST(request, { params: Promise.resolve({ id: active.getSessionId() }) });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  assert.equal(result.sessionId, source.getSessionId());
  assert.equal((await listAllSessions()).some((session) => session.id === result.sessionId), true);
  assert.equal((await listAllSessions()).find((session) => session.id === result.sessionId)?.cwd, cwd);
});
