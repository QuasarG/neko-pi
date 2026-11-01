import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { shareDialogInfoFrom, shareDestinationTextKey, attachmentFileName } = await jiti.import("./ShareDialog.tsx");
const { bugReportNextStep, bugReportModelLabel } = await jiti.import("./BugReportDialog.tsx");

test("the share dialog reads the persisted destination", () => {
  assert.deepEqual(
    shareDialogInfoFrom(true, 200, { destination: "gist", gatewayHost: "gateway.test" }),
    { state: "loaded", info: { destination: "gist", gatewayHost: "gateway.test" } },
  );
  assert.equal(shareDialogInfoFrom(true, 200, { destination: "auto", gatewayHost: "gateway.test" }).state, "loaded");
  assert.equal(shareDialogInfoFrom(true, 200, { destination: "elsewhere", gatewayHost: "gateway.test" }).state, "failed");
  assert.equal(shareDialogInfoFrom(false, 500, { error: "boom" }).error, "boom");
  assert.match(shareDialogInfoFrom(false, 502, {}).error, /HTTP 502/);
});

test("every destination renders its own text", () => {
  assert.deepEqual(
    ["auto", "radius", "gist"].map(shareDestinationTextKey),
    ["share.destination.auto", "share.destination.radius", "share.destination.gist"],
  );
});

test("the download keeps the server's file name, with a fallback", () => {
  assert.equal(
    attachmentFileName('attachment; filename="session-abc.jsonl"; filename*=UTF-8\'\'session-%C3%A9.jsonl', "fallback.jsonl"),
    "session-é.jsonl",
  );
  assert.equal(attachmentFileName('attachment; filename="session-abc.jsonl"', "fallback.jsonl"), "session-abc.jsonl");
  assert.equal(attachmentFileName(null, "fallback.jsonl"), "fallback.jsonl");
  assert.equal(attachmentFileName("attachment", "fallback.jsonl"), "fallback.jsonl");
});

test("the bug steps follow the TUI sequence: summary only when the transcript is declined", () => {
  assert.equal(bugReportNextStep("hint", false), "transcript");
  assert.equal(bugReportNextStep("transcript", true), "delivery");
  assert.equal(bugReportNextStep("transcript", false), "summary");
  assert.equal(bugReportNextStep("summary", true), "delivery");
  assert.equal(bugReportNextStep("summary", false), "delivery");
  assert.equal(bugReportNextStep("delivery", true), null);
});

test("the model label falls back to empty so the copy can say \"the current model\"", () => {
  assert.equal(bugReportModelLabel({ provider: "faux", modelId: "faux-one" }), "faux-one");
  assert.equal(bugReportModelLabel(null), "");
});
