import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-share-bug-agent-"));
process.env.NEKO_PI_HOME = agentDir;

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { executeShareCommand, executeBugReportCommand } = await jiti.import("./share-bug-commands.ts");

test.after(() => rm(agentDir, { recursive: true, force: true }));

/** A live session on a persisted file, as a wrapper's inner session is. */
async function liveSession(t, { destination } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-share-bug-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const faux = fauxProvider({ models: [{ id: "faux-share-bug" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = destination
    ? SettingsManager.inMemory()
    : SettingsManager.inMemory();
  if (destination) settingsManager.setSessionShareDestination(destination);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-share-bug"),
    sessionManager,
    settingsManager,
    resourceLoader,
  });
  // A session file is created only once a conversation exists (_persist), so
  // give the session one user turn the flows then serialize and append to.
  session.sessionManager.appendMessage({ role: "user", content: "share-bug probe", timestamp: Date.now() });
  t.after(() => session.dispose());
  return { session, faux, sessionManager, cwd };
}

/** The lines of a session JSONL file, parsed. */
const readEntries = (manager) =>
  readFileSync(manager.getSessionFile(), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));

test("download returns the branch plus the pi.share trailer, with no network", async (t) => {
  const { session } = await liveSession(t);
  session.sessionManager.appendCustomEntry("probe-entry", { hello: "world" });

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { calls.push(args); throw new Error("network is mocked out"); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await executeShareCommand(session, { delivery: "download" });
  assert.equal(result.mode, "download");
  assert.deepEqual(calls, []);

  const lines = result.jsonl.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].type, "session");
  assert.equal(lines[0].id, session.sessionId);
  const trailer = lines.at(-1);
  assert.equal(trailer.type, "custom");
  assert.equal(trailer.customType, "pi.share");
  assert.equal(typeof trailer.data.systemPrompt, "string");
  assert.ok(Array.isArray(trailer.data.tools));
  assert.ok(trailer.data.tools.some((tool) => typeof tool.name === "string" && typeof tool.parameters === "object"));
  assert.match(result.fileName, /^session-.*\.jsonl$/);
});

test("upload honors the persisted destination: radius without auth says how to configure it", async (t) => {
  const { session } = await liveSession(t, { destination: "radius" });
  await assert.rejects(
    executeShareCommand(session, { delivery: "upload" }),
    /Radius authentication is not configured/,
  );
});

/** A PATH holding only the given fake `gh`; the host's real gh is unreachable. */
async function fakeGhPath(t, script) {
  const binDir = await mkdtemp(join(tmpdir(), "pi-web-share-bug-bin-"));
  t.after(() => rm(binDir, { recursive: true, force: true }));
  await writeFile(join(binDir, "gh"), script, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = binDir;
  t.after(() => { process.env.PATH = previousPath; });
  return binDir;
}

test("upload with the gist destination requires a logged-in gh", async (t) => {
  const { session } = await liveSession(t, { destination: "gist" });
  // Hermetic: PATH holds only a stub gh that fails `auth status`, so a host
  // with a real, authenticated gh can never be reached from this test.
  await fakeGhPath(t, "#!/bin/sh\nexit 1\n");
  await assert.rejects(
    executeShareCommand(session, { delivery: "upload" }),
    /GitHub CLI is not logged in/,
  );
});

test("an authenticated gh is still the stub: a failed gist create surfaces and nothing leaves", async (t) => {
  const { session } = await liveSession(t, { destination: "gist" });
  await fakeGhPath(t, [
    "#!/bin/sh",
    'if [ "$1" = "auth" ]; then exit 0; fi',
    'if [ "$1" = "gist" ]; then echo "stub refuses to upload" >&2; exit 1; fi',
    "exit 1",
  ].join("\n"));
  // The export to HTML is a local temp file; the only gh that runs is the stub.
  await assert.rejects(
    executeShareCommand(session, { delivery: "upload" }),
    /Failed to create gist: stub refuses to upload/,
  );
});

test("bug zip: same pi.bug-report entry as the TUI, with the chosen consent fields", async (t) => {
  const { session, sessionManager } = await liveSession(t);
  await writeFile(join(agentDir, "crashes.json"), JSON.stringify([{
    timestamp: "2026-10-01T00:00:00.000Z",
    version: "test",
    kind: "fatal_error",
    message: "boom",
    stack: null,
    sessionFile: null,
    cwd: "/tmp",
  }]));

  const result = await executeBugReportCommand(session, {
    hint: " the model hung ",
    includeSession: true,
    includeSummary: false,
    delivery: "zip",
  });
  assert.equal(result.mode, "zip");

  const entries = readEntries(sessionManager);
  const record = entries.at(-1);
  assert.equal(record.type, "custom");
  assert.equal(record.customType, "pi.bug-report");
  assert.deepEqual(
    { id: record.data.id, createdAt: record.data.createdAt, hint: record.data.hint },
    { id: result.reportId, createdAt: result.recorded.createdAt, hint: "the model hung" },
  );
  assert.equal(record.data.sessionIncluded, true);
  assert.equal(record.data.summaryIncluded, false);
  assert.equal(record.data.delivery, "zip");
  assert.equal("path" in record.data, false, "a browser download has no server-side path");
  assert.equal(result.recorded.delivery, "zip");

  const zip = Buffer.from(result.zipBase64, "base64");
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "the download is a zip archive");
  // Entry names live uncompressed in the central directory; the file contents
  // are deflated, so the trailer itself is proven by the download test above.
  const names = zip.toString("latin1");
  assert.ok(names.includes("report.json"));
  assert.ok(names.includes("diagnostics.json"));
  assert.ok(names.includes("session.jsonl"), "the consented transcript is in the archive");
  assert.match(result.fileName, /^pi-bug-report-.*\.zip$/);
  // A successful delivery clears the crash log the report attached.
  assert.equal(existsSync(join(agentDir, "crashes.json")), false);
});

test("bug zip without the transcript omits session.jsonl but keeps the entry", async (t) => {
  const { session, sessionManager } = await liveSession(t);
  const result = await executeBugReportCommand(session, {
    includeSession: false,
    includeSummary: false,
    delivery: "zip",
  });
  const names = Buffer.from(result.zipBase64, "base64").toString("latin1");
  assert.ok(names.includes("report.json"));
  assert.ok(!names.includes("session.jsonl"));

  const record = readEntries(sessionManager).at(-1);
  assert.equal(record.customType, "pi.bug-report");
  assert.equal(record.data.sessionIncluded, false);
  assert.equal(record.data.delivery, "zip");
});

test("PI_OFFLINE blocks upload with the native message", async (t) => {
  const { session } = await liveSession(t);
  const previous = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  });
  await assert.rejects(
    executeBugReportCommand(session, { includeSession: false, includeSummary: false, delivery: "upload" }),
    /requires online mode/,
  );
});

test("bug upload posts to the gateway and records delivery \"upload\"", async (t) => {
  const { session, sessionManager } = await liveSession(t);
  const previousGateway = process.env.PI_RADIUS_GATEWAY;
  process.env.PI_RADIUS_GATEWAY = "https://gateway.test";
  t.after(() => {
    if (previousGateway === undefined) delete process.env.PI_RADIUS_GATEWAY;
    else process.env.PI_RADIUS_GATEWAY = previousGateway;
  });

  const uploads = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    uploads.push({ input: String(input), init });
    return new Response(JSON.stringify({ ok: true, bug_report: { id: "br-test-1" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await executeBugReportCommand(session, {
    hint: "crashed",
    includeSession: true,
    includeSummary: false,
    delivery: "upload",
  });
  assert.equal(result.mode, "upload");
  assert.equal(result.reportId, "br-test-1");
  assert.equal(uploads.length, 1);
  assert.equal(new URL(uploads[0].input).host, "gateway.test");
  assert.equal(new URL(uploads[0].input).pathname, "/v1/bug-reports");

  const record = readEntries(sessionManager).at(-1);
  assert.equal(record.customType, "pi.bug-report");
  assert.equal(record.data.delivery, "upload");
  assert.equal(record.data.hint, "crashed");
  assert.equal(record.data.sessionIncluded, true);
});

test("the optional summary runs through the live session's model", async (t) => {
  const { session, faux, sessionManager } = await liveSession(t);
  faux.setResponses([fauxAssistantMessage([fauxText("The user asked for a file and the tool failed.")])]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, bug_report: { id: "br-test-2" } }), { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await executeBugReportCommand(session, {
    includeSession: false,
    includeSummary: true,
    delivery: "upload",
  });
  assert.equal(result.mode, "upload");
  const record = readEntries(sessionManager).at(-1);
  assert.equal(record.data.sessionIncluded, false);
  assert.equal(record.data.summaryIncluded, true);
});
