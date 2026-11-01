import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-bug-route-agent-"));
process.env.NEKO_PI_HOME = agentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});
const { startRpcSession } = await jiti.import("../../../../../lib/rpc-manager.ts");
const { GET, POST } = await jiti.import("./route.ts");

const JSON_HEADERS = { host: "localhost", "Content-Type": "application/json" };

test.after(() => rm(agentDir, { recursive: true, force: true }));

/** A live wrapper with one user turn, as the browser's /bug talks to. */
async function startedSession(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-bug-route-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const started = await startRpcSession("__new__bug-route", "", cwd, {});
  const wrapper = started.session;
  t.after(() => wrapper.destroy());
  wrapper.inner.sessionManager.appendMessage({ role: "user", content: "it broke", timestamp: Date.now() });
  return { id: started.realSessionId, wrapper };
}

const post = (id, body) => POST(
  new Request(`http://localhost/api/sessions/${id}/bug-report`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id }) },
);

test("GET names the gateway host and whether uploading is offline-blocked", async (t) => {
  const previous = process.env.PI_RADIUS_GATEWAY;
  process.env.PI_RADIUS_GATEWAY = "https://gateway.test";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_RADIUS_GATEWAY;
    else process.env.PI_RADIUS_GATEWAY = previous;
  });

  const { id } = await startedSession(t);
  const response = await GET(
    new Request(`http://localhost/api/sessions/${id}/bug-report`, { headers: { host: "localhost" } }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { gatewayHost: "gateway.test", offline: false });
});

test("zip delivery streams an archive and records the consent in the session JSONL", async (t) => {
  const { id, wrapper } = await startedSession(t);
  const response = await post(id, {
    hint: "crashed after the second turn",
    includeSession: true,
    includeSummary: false,
    delivery: "zip",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="pi-bug-report-/);

  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(archive.readUInt32LE(0), 0x04034b50, "the response body is a zip");
  const names = archive.toString("latin1");
  assert.ok(names.includes("report.json"));
  assert.ok(names.includes("session.jsonl"));

  const entries = readFileSync(wrapper.inner.sessionFile, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  const record = entries.at(-1);
  assert.equal(record.type, "custom");
  assert.equal(record.customType, "pi.bug-report");
  assert.equal(record.data.hint, "crashed after the second turn");
  assert.equal(record.data.sessionIncluded, true);
  assert.equal(record.data.summaryIncluded, false);
  assert.equal(record.data.delivery, "zip");
});

test("PI_OFFLINE blocks upload with the native message", async (t) => {
  const { id } = await startedSession(t);
  const previous = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  });

  const response = await post(id, { includeSession: false, includeSummary: false, delivery: "upload" });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /requires online mode/);
});

test("upload delivery answers with the report id and records delivery \"upload\"", async (t) => {
  const { id, wrapper } = await startedSession(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ ok: true, bug_report: { id: "br-route-1" } }),
    { status: 200 },
  );
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await post(id, { hint: "broken", includeSession: false, includeSummary: false, delivery: "upload" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reportId: "br-route-1" });

  const entries = readFileSync(wrapper.inner.sessionFile, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  const record = entries.at(-1);
  assert.equal(record.customType, "pi.bug-report");
  assert.equal(record.data.delivery, "upload");
  assert.equal(record.data.sessionIncluded, false);
});

test("a malformed consent payload is refused without touching the session", async (t) => {
  const { id } = await startedSession(t);
  const response = await post(id, { includeSession: "yes", delivery: "zip" });
  assert.equal(response.status, 400);
});
