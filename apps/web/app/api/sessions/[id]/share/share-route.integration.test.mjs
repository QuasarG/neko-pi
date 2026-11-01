import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-share-route-agent-"));
process.env.NEKO_PI_HOME = agentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});
const { startRpcSession } = await jiti.import("../../../../../lib/rpc-manager.ts");
const { GET, POST } = await jiti.import("./route.ts");

const JSON_HEADERS = { host: "localhost", "Content-Type": "application/json" };

test.after(() => rm(agentDir, { recursive: true, force: true }));

/** A live wrapper with one user turn, as the browser's /share talks to. */
async function startedSession(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-share-route-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const started = await startRpcSession("__new__share-route", "", cwd, {});
  const wrapper = started.session;
  t.after(() => wrapper.destroy());
  wrapper.inner.sessionManager.appendMessage({ role: "user", content: "share me", timestamp: Date.now() });
  return { id: started.realSessionId, wrapper };
}

const request = (id, method, body) => new Request(`http://localhost/api/sessions/${id}/share`, {
  method,
  headers: JSON_HEADERS,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("GET reads the destination the TUI's /share uses", async (t) => {
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ sessionShareDestination: "gist" }));
  const { id } = await startedSession(t);

  const response = await GET(
    new Request(`http://localhost/api/sessions/${id}/share`, { headers: { host: "localhost" } }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.destination, "gist");
  assert.equal(typeof data.gatewayHost, "string");
  assert.ok(data.gatewayHost.length > 0);
});

test("GET defaults to the auto destination without a setting", async (t) => {
  await rm(join(agentDir, "settings.json"), { force: true });
  const { id } = await startedSession(t);
  const response = await GET(
    new Request(`http://localhost/api/sessions/${id}/share`, { headers: { host: "localhost" } }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal((await response.json()).destination, "auto");
});

test("POST download returns the pi.share JSONL without any network", async (t) => {
  const { id, wrapper } = await startedSession(t);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { calls.push(args); throw new Error("network is mocked out"); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await POST(request(id, "POST", { delivery: "download" }), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="session-/);
  assert.equal(calls.length, 0, "downloading never uploads");

  const lines = (await response.text()).trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].type, "session");
  assert.equal(lines[0].id, wrapper.inner.sessionId);
  const trailer = lines.at(-1);
  assert.equal(trailer.type, "custom");
  assert.equal(trailer.customType, "pi.share");
  assert.equal(typeof trailer.data.systemPrompt, "string");
  assert.ok(Array.isArray(trailer.data.tools));
});

test("POST rejects a bad delivery and an unknown session", async (t) => {
  const { id } = await startedSession(t);
  const bad = await POST(request(id, "POST", { delivery: "elsewhere" }), { params: Promise.resolve({ id }) });
  assert.equal(bad.status, 400);

  const missing = await POST(request("nope", "POST", { delivery: "download" }), { params: Promise.resolve({ id: "nope" }) });
  assert.equal(missing.status, 404);
});

test("cross-site requests are refused before anything runs", async () => {
  const refused = await GET(
    new Request("http://localhost/api/sessions/x/share", {
      headers: { host: "localhost", origin: "https://evil.example" },
    }),
    { params: Promise.resolve({ id: "x" }) },
  );
  assert.equal(refused.status, 403);
});

test("radius destination without auth surfaces the native guidance", async (t) => {
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ sessionShareDestination: "radius" }));
  const { id } = await startedSession(t);
  const response = await POST(request(id, "POST", { delivery: "upload" }), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /Radius authentication is not configured/);
});
