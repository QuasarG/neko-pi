import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { matchAskUserQuestion, askUserSubmitPayload, toggleAskUserOption } = await jiti.import("./ask-user-view.ts");
const input = { header: "Database", question: "Which database?", options: [{ label: " Postgres ", description: " Production " }, { label: "SQLite" }], background: true };
const request = { method: "select", title: "Database: Which database?", options: ["Postgres", "SQLite"] };
const assistant = { role: "assistant", content: [{ type: "toolCall", toolCallId: "q1", toolName: "ask_user", input }] };
test("recovers question descriptions, background mode and multi-select from saved or streaming tool input", () => {
  const expected = { header: "Database", question: "Which database?", options: [{ label: "Postgres", description: "Production" }, { label: "SQLite", description: undefined }], background: true, multiSelect: false };
  assert.deepEqual(matchAskUserQuestion(request, [assistant]), expected);
  assert.deepEqual(matchAskUserQuestion(request, [], assistant), expected);
  const multi = { role: "assistant", content: [{ type: "toolCall", toolCallId: "q2", toolName: "ask_user", input: { ...input, multi_select: true } }] };
  assert.equal(matchAskUserQuestion(request, [multi]).multiSelect, true);
});
test("unrelated extension selections stay in their own dialog", () => {
  assert.equal(matchAskUserQuestion({ ...request, title: "Pick a model" }, [assistant]), null);
  assert.equal(matchAskUserQuestion({ ...request, options: ["MySQL", "SQLite"] }, [assistant]), null);
});
test("multi-select toggling only changes the selection set", () => {
  assert.deepEqual(toggleAskUserOption(true, [], "Postgres"), ["Postgres"]);
  assert.deepEqual(toggleAskUserOption(true, ["Postgres"], "Postgres"), []);
  assert.deepEqual(toggleAskUserOption(true, ["Postgres"], "SQLite"), ["Postgres", "SQLite"]);
  // Single-select replaces: at most one label ever held.
  assert.deepEqual(toggleAskUserOption(false, ["Postgres"], "SQLite"), ["SQLite"]);
});
test("submit payload sends the whole ticked set as a real array in offered order", () => {
  const question = { options: [{ label: "Postgres" }, { label: "SQLite" }, { label: "Redis" }], multiSelect: true };
  assert.deepEqual(askUserSubmitPayload(question, ["Redis", "Postgres"], ""), { values: ["Postgres", "Redis"] });
  assert.deepEqual(askUserSubmitPayload(question, ["SQLite"], ""), { values: ["SQLite"] });
});
test("single-select still submits one label as a string", () => {
  const question = { options: [{ label: "Postgres" }, { label: "SQLite" }], multiSelect: false };
  assert.deepEqual(askUserSubmitPayload(question, ["SQLite"], ""), { value: "SQLite" });
});
test("an empty selection cannot submit, in either mode", () => {
  const single = { options: [{ label: "Postgres" }], multiSelect: false };
  const multi = { options: [{ label: "Postgres" }], multiSelect: true };
  assert.equal(askUserSubmitPayload(single, [], ""), null);
  assert.equal(askUserSubmitPayload(multi, [], ""), null);
  assert.equal(askUserSubmitPayload(multi, [], "   "), null);
});
test("a written free-text answer wins over ticked options in both modes", () => {
  const single = { options: [{ label: "Postgres" }], multiSelect: false };
  const multi = { options: [{ label: "Postgres" }], multiSelect: true };
  assert.deepEqual(askUserSubmitPayload(single, ["Postgres"], "Use Redis"), { value: "Use Redis" });
  assert.deepEqual(askUserSubmitPayload(multi, ["Postgres"], "Use Redis"), { value: "Use Redis" });
});
