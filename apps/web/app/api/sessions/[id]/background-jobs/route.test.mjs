import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: backgroundJobsRoute } = await jiti.import("./route.ts");
// The registry the route reads; the deep module file is the SAME module the
// runtime barrel re-exports, so both share one job table.
const {
  clearFinishedBackgroundJobs,
  finishBackgroundJob,
  registerBackgroundJob,
} = await jiti.import(`${process.cwd()}/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/background-jobs.js`);

function get(path, id) {
  // Next.js route handlers receive { params } as a promise.
  return backgroundJobsRoute(new Request(`http://localhost${path}`), { params: Promise.resolve({ id }) });
}

test.afterEach(() => clearFinishedBackgroundJobs());

test("lists the session's jobs, running and finished alike", async () => {
  const sessionId = `route-list-${randomUUID()}`;
  const other = `route-other-${randomUUID()}`;
  const bash = registerBackgroundJob({ sessionId, kind: "bash", label: "npm test" });
  registerBackgroundJob({ sessionId: other, kind: "bash", label: "other session" });
  const subagent = registerBackgroundJob({ sessionId, kind: "subagent", label: "researcher: dig" });
  finishBackgroundJob(subagent.id, { status: "failed", summary: "boom" });

  const res = await get(`/api/sessions/${encodeURIComponent(sessionId)}/background-jobs`, sessionId);
  assert.equal(res.status, 200);
  const data = await res.json();
  const ids = data.data.jobs.map((job) => job.id).sort();
  assert.deepEqual(ids, [bash.id, subagent.id].sort());
  const finished = data.data.jobs.find((job) => job.id === subagent.id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.kind, "subagent");
});

test("an unknown session with no jobs is a 404", async () => {
  const res = await get(`/api/sessions/route-missing-${Date.now()}/background-jobs`, `route-missing-${Date.now()}`);
  assert.equal(res.status, 404);
});

test("a job's spool output reads back with the registry's status", async () => {
  const sessionId = `route-output-${randomUUID()}`;
  const spoolName = `neko-bg-${randomUUID()}.log`;
  const spoolPath = join(tmpdir(), spoolName);
  await writeFile(spoolPath, "line one\nline two\n", "utf8");
  const job = registerBackgroundJob({ sessionId, kind: "bash", label: "npm test", outputFile: spoolPath });

  try {
    const res = await get(`/api/sessions/${encodeURIComponent(sessionId)}/background-jobs?jobId=${encodeURIComponent(job.id)}`, sessionId);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.data.status, "running");
    assert.equal(data.data.output, "line one\nline two\n");
    assert.equal(data.data.outputFile, spoolPath);

    const download = await get(`/api/sessions/${encodeURIComponent(sessionId)}/background-jobs?jobId=${encodeURIComponent(job.id)}&download=1`, sessionId);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /attachment/);
    assert.equal(await download.text(), "line one\nline two\n");
  } finally {
    await rm(spoolPath, { force: true });
  }
});

test("jobId mode: a foreign session's job, a subagent job, or an unknown id is 404; a bad spool path is read_failed", async () => {
  const mine = `route-guard-${randomUUID()}`;
  const theirs = `route-guard-other-${randomUUID()}`;
  const foreign = registerBackgroundJob({ sessionId: theirs, kind: "bash", label: "theirs" });
  assert.equal((await get(`/api/sessions/${encodeURIComponent(mine)}/background-jobs?jobId=${encodeURIComponent(foreign.id)}`, mine)).status, 404);

  const subagent = registerBackgroundJob({ sessionId: mine, kind: "subagent", label: "agent" });
  assert.equal((await get(`/api/sessions/${encodeURIComponent(mine)}/background-jobs?jobId=${encodeURIComponent(subagent.id)}`, mine)).status, 404);
  assert.equal((await get(`/api/sessions/${encodeURIComponent(mine)}/background-jobs?jobId=bg-nope`, mine)).status, 404);

  // A path outside the temp root never resolves, even if a job claims it.
  const rogue = join(await mkdtemp(join(tmpdir(), "route-spool-")), "neko-bg-mismatch.log");
  await writeFile(rogue, "x", "utf8");
  const rogueJob = registerBackgroundJob({
    sessionId: mine,
    kind: "bash",
    label: "rogue",
    // Deliberately not the neko-bg-in-tmpdir shape the resolver requires.
    outputFile: rogue,
  });
  const res = await get(`/api/sessions/${encodeURIComponent(mine)}/background-jobs?jobId=${encodeURIComponent(rogueJob.id)}`, mine);
  assert.equal(res.status, 500);
  const data = await res.json();
  assert.equal(data.error, "read_failed");
});
