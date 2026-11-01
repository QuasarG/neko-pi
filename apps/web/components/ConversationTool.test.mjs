import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ConversationTool } = await jiti.import("./ConversationTool.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { setToolCallExpanded } = await jiti.import("@/lib/tool-call-expansion");

function renderTool({ toolName, input, result }) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ConversationTool, {
        block: { type: "toolCall", toolCallId: `call-${toolName}`, toolName, input },
        result,
      }),
    ),
  );
}

const textResult = (text, isError = false) => ({
  role: "toolResult",
  toolCallId: "call-goal_update",
  toolName: "goal_update",
  content: [{ type: "text", text }],
  isError,
});

test.afterEach(() => setToolCallExpanded(undefined, false));

test("goal_update collapsed row shows the reason and the outcome chip", () => {
  const html = renderTool({
    toolName: "goal_update",
    input: { status: "completed", reason: "build is green again" },
    result: textResult("Goal marked completed: build is green again. The continuation loop stops."),
  });

  assert.match(html, /tool-kind[^>]*>Goal</);
  assert.match(html, /tool-summary-roll tool-summary-text"><span class="tool-summary-roll-item">build is green again<\/span>/);
  assert.match(html, /tool-status" data-goal-status="completed">Completed</);
  // Details stay available behind the toggle.
  assert.match(html, /aria-expanded="false"/);
});

test("goal_update without a reason falls back to its status word, never an empty summary", () => {
  const html = renderTool({
    toolName: "goal_update",
    input: { status: "failed" },
    result: textResult("Goal marked failed. The continuation loop stops."),
  });

  assert.match(html, /tool-summary-roll tool-summary-text"><span class="tool-summary-roll-item">Failed<\/span>/);
  assert.match(html, /tool-status" data-goal-status="failed">Failed</);
});

test("goal_update expanded detail leads with the outcome, then the result text", () => {
  setToolCallExpanded("call-goal_update", true);
  const html = renderTool({
    toolName: "goal_update",
    input: { status: "completed", reason: "all tests pass" },
    result: textResult("Goal marked completed: all tests pass. The continuation loop stops."),
  });

  assert.match(html, /tool-goal-detail/);
  assert.match(html, /tool-goal-state" data-goal-status="completed">Completed</);
  assert.match(html, /tool-goal-reason">all tests pass</);
  assert.match(html, /The continuation loop stops/);
});

test("todo_write renders a checklist: current step summary, done count, per-item status", () => {
  const html = renderTool({
    toolName: "todo_write",
    input: {
      items: [
        { content: "plan the fix", status: "completed" },
        { content: "patch the parser", status: "in_progress" },
        { content: "verify the build", status: "pending" },
      ],
    },
    result: {
      role: "toolResult",
      toolCallId: "call-todo_write",
      toolName: "todo_write",
      content: [{ type: "text", text: "待办 1/3\n  ✓ plan the fix\n  ▸ patch the parser\n  ○ verify the build" }],
    },
  });

  // Collapsed: the in-progress step is the summary, the count chip is done/total.
  assert.match(html, /tool-summary-roll tool-summary-text"><span class="tool-summary-roll-item">patch the parser<\/span>/);
  assert.match(html, /tool-status">1\/3</);
  assert.doesNotMatch(html, /data-goal-status/);
});

test("todo_write with no in-progress step still says something: first pending, else an all-done word", () => {
  const pending = renderTool({
    toolName: "todo_write",
    input: {
      items: [
        { content: "plan the fix", status: "completed" },
        { content: "verify the build", status: "pending" },
      ],
    },
    result: {
      role: "toolResult",
      toolCallId: "call-todo_write",
      toolName: "todo_write",
      content: [{ type: "text", text: "待办 1/2" }],
    },
  });
  // No step running yet: the first pending one carries the summary.
  assert.match(pending, /tool-summary-roll tool-summary-text"><span class="tool-summary-roll-item">verify the build<\/span>/);
  assert.match(pending, /tool-status">1\/2</);

  const done = renderTool({
    toolName: "todo_write",
    input: { items: [{ content: "plan the fix", status: "completed" }] },
    result: {
      role: "toolResult",
      toolCallId: "call-todo_write",
      toolName: "todo_write",
      content: [{ type: "text", text: "待办 1/1" }],
    },
  });
  // Everything complete: the i18n'd all-done word, never an empty summary.
  assert.match(done, /tool-summary-roll tool-summary-text"><span class="tool-summary-roll-item">All steps complete<\/span>/);
  assert.match(done, /tool-status">1\/1</);
});

test("todo_write expanded checklist marks completed, in-progress and pending items", () => {
  setToolCallExpanded("call-todo_write", true);
  const html = renderTool({
    toolName: "todo_write",
    input: {
      items: [
        { content: "plan the fix", status: "completed" },
        { content: "patch the parser", status: "in_progress" },
        { content: "verify the build", status: "pending" },
      ],
    },
    result: {
      role: "toolResult",
      toolCallId: "call-todo_write",
      toolName: "todo_write",
      content: [{ type: "text", text: "待办 1/3" }],
    },
  });

  assert.match(html, /tool-checklist/);
  assert.match(html, /li data-status="completed"[^>]*><span aria-hidden="true">✓<\/span>plan the fix</);
  assert.match(html, /li data-status="in_progress"[^>]*><span aria-hidden="true">▸<\/span>patch the parser</);
  assert.match(html, /li data-status="pending"[^>]*><span aria-hidden="true">○<\/span>verify the build</);
});

test("a failed goal_update row keeps neutral ink; the error lives in the status tooltip (§2.4)", () => {
  const html = renderTool({
    toolName: "goal_update",
    input: { status: "completed" },
    result: textResult("No active goal to update.", true),
  });

  // §2.4: the row never trades color for a state — no is-error marker.
  assert.match(html, /class="conversation-tool"/);
  assert.match(html, /tool-summary-roll tool-summary-text"><span class="tool-summary-roll-item">Completed<\/span>/);
  // Failure = the dotted-underline status word, its tooltip carrying the error.
  assert.match(html, /aria-label="Failed"/);
  assert.match(html, /tool-error-word">Failed</);
  assert.match(html, /tool-error-text">No active goal to update\./);
  assert.match(html, /tool-error-copy/);
});

test("a pending row sweeps its kind label; the glyph is the §2.7 lucide set at stroke 2", () => {
  const html = renderTool({
    toolName: "todo_write",
    input: { items: [{ content: "one step", status: "pending" }] },
  });
  // Running = the §2.3 sweep on the kind label; nothing else changes.
  assert.match(html, /tool-kind animated-gradient-text">Plan</);
  // §2.7: 16px, lucide's default stroke 2, verbatim ListTodo geometry.
  assert.match(html, /<svg class="tool-glyph" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"/);
  assert.match(html, /<rect x="3" y="4" width="6" height="6" rx="1"/);
  // §2.2: the 16px ChevronRight, rotated open through aria-expanded.
  assert.match(html, /<svg class="tool-chevron" width="16" height="16"[^>]*><path d="m9 18 6-6-6-6"/);
});
