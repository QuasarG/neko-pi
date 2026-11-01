import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
});
const {
  backgroundJobsToWorks,
  latestTodoWriteItems,
  runningSubagentRows,
} = await jiti.import("./status-panel-data.ts");

test("only running bash jobs become card works", () => {
  const jobs = [
    { id: "bg-1", kind: "bash", label: "npm test", startedAt: 5, status: "running" },
    { id: "bg-2", kind: "bash", label: "done cmd", startedAt: 3, status: "completed" },
    { id: "bg-3", kind: "subagent", label: "researcher: dig", startedAt: 4, status: "running" },
  ];
  assert.deepEqual(backgroundJobsToWorks(jobs), [
    { workId: "bg-1", kind: "bash", title: "npm test", startedAt: 5 },
  ]);
});

test("running subagent rows take title from the relation and startedAt from modified time", () => {
  const subagents = [
    {
      id: "s1",
      name: "name",
      firstMessage: "first",
      modified: "2026-10-31T10:00:00.000Z",
      relation: { kind: "subagent", parentSessionId: "p", profile: "researcher", description: "dig deeper", status: "running" },
    },
    {
      id: "s2",
      name: "other",
      firstMessage: "m",
      modified: "not-a-date",
      relation: { kind: "subagent", parentSessionId: "p", profile: "writer", description: "", status: "running" },
    },
    {
      id: "s3",
      name: "finished",
      firstMessage: "m",
      modified: "2026-10-31T10:00:00.000Z",
      relation: { kind: "subagent", parentSessionId: "p", profile: "idle", description: "already done", status: "completed" },
    },
  ];
  const rows = runningSubagentRows(subagents, new Set(["s1", "s2"]));
  assert.deepEqual(rows, [
    { childSessionId: "s1", title: "dig deeper", startedAt: Date.parse("2026-10-31T10:00:00.000Z") },
    // An empty description falls back to the profile; an unparseable modified
    // time yields no startedAt rather than a fake zero.
    { childSessionId: "s2", title: "writer", startedAt: null },
  ]);
});

const todoBlock = (toolCallId, items) => ({
  role: "assistant",
  content: [{ type: "toolCall", toolCallId, toolName: "todo_write", input: { items } }],
});

test("the latest todo_write snapshot wins entirely, mapped to the card's statuses", () => {
  const messages = [
    todoBlock("call-1", [{ content: "old plan", status: "completed" }]),
    { role: "user", content: "go" },
    todoBlock("call-2", [
      { content: "step one", status: "completed" },
      { content: "step two", status: "in_progress" },
      { content: "step three" },
    ]),
  ];
  assert.deepEqual(latestTodoWriteItems(messages), [
    { id: "call-2:0", content: "step one", status: "completed" },
    { id: "call-2:1", content: "step two", status: "inProgress" },
    { id: "call-2:2", content: "step three", status: "pending" },
  ]);
});

test("a transcript without todo_write, or one with no items array, has no plan", () => {
  assert.deepEqual(latestTodoWriteItems([{ role: "user", content: "hi" }]), []);
  assert.deepEqual(latestTodoWriteItems([todoBlock("call-x", undefined)]), []);
});
