import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const panel = await jiti.import("./conversation-status-panel.tsx");
const {
  buildStatusPanelModel,
  COMPACT_TODO_THRESHOLD,
  ConversationStatusPanel,
  formatBackgroundTaskElapsedLabel,
  formatDurationUnits,
  getStatusPanelSummarySelection,
  getStatusPanelTodoFocusWindow,
  TODO_FOCUS_WINDOW_SIZE,
} = panel;
const {
  BackgroundWorkBadges,
  composerBackgroundWorkTooltipKey,
  getComposerBackgroundWorkCounts,
} = await jiti.import("./background-work-badges.tsx");
const { BackgroundBashOutput, nextBashFollowAction } = await jiti.import("./BackgroundBashOutput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const item = (id, content, status) => ({ id, content, status });
const work = (workId, startedAt) => ({ workId, kind: "bash", title: `cmd ${workId}`, startedAt });
const subagent = (childSessionId, startedAt = null) => ({ childSessionId, title: `agent ${childSessionId}`, startedAt });
const goal = (status = "active") => ({ rounds: 3, maxRounds: 20, status, objective: "make the build green" });

const t = (key, values) => {
  const messages = {
    "chat.longRunning.elapsedSeconds": "Running for {seconds}s",
    "chat.longRunning.elapsedMinutesSeconds": "Running for {minutes}m {seconds}s",
    "chat.summaryPanel.duration.hours": "h",
    "chat.summaryPanel.duration.minutes": "m",
    "chat.summaryPanel.duration.seconds": "s",
  };
  return (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? ""));
};

function render(element) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, element));
}

/* ── Model (C.2 mount gates) ─────────────────────────────────────────── */

test("the model keeps only live content: running bash works, subagents, a goal line, a todo snapshot", () => {
  const empty = buildStatusPanelModel({ goal: null, todoItems: [], works: [], subagents: [] });
  assert.equal(empty.hasContent, false);

  const full = buildStatusPanelModel({
    goal: goal(),
    todoItems: [item("a", "step", "pending")],
    works: [work("bg-1", 1)],
    subagents: [subagent("s1")],
  });
  assert.equal(full.hasContent, true);
  assert.equal(full.runningBashWorks.length, 1);
  assert.equal(full.plan.completedCount, 0);
  assert.equal(full.plan.totalCount, 1);
});

test("empty-content todo items are not a plan", () => {
  const model = buildStatusPanelModel({ goal: null, todoItems: [item("a", "  ", "pending")], works: [], subagents: [] });
  assert.equal(model.plan, null);
  assert.equal(model.hasContent, false);
});

/* ── Todo focus window (C.4, thresholds 6/3 verbatim) ────────────────── */

test("six or fewer items never compact", () => {
  assert.equal(COMPACT_TODO_THRESHOLD, 6);
  assert.equal(TODO_FOCUS_WINDOW_SIZE, 3);
  const items = Array.from({ length: 6 }, (_, index) => item(`i${index}`, `step ${index}`, "completed"));
  const window = getStatusPanelTodoFocusWindow(items);
  assert.equal(window.compact, false);
  assert.equal(window.focusItems.length, 6);
});

test("a long list windows three around the in-progress item, backfilled from the front", () => {
  const items = [
    ...Array.from({ length: 5 }, (_, index) => item(`d${index}`, `done ${index}`, "completed")),
    item("run", "current step", "inProgress"),
    ...Array.from({ length: 3 }, (_, index) => item(`p${index}`, `pending ${index}`, "pending")),
  ];
  const window = getStatusPanelTodoFocusWindow(items);
  assert.equal(window.compact, true);
  // The window starts at the running item ("current + two after"), backfilling
  // from the front only when the focus sits near the list's end.
  assert.deepEqual(window.focusItems.map((entry) => entry.id), ["run", "p0", "p1"]);
  assert.deepEqual(window.precedingItems.map((entry) => entry.id), ["d0", "d1", "d2", "d3", "d4"]);
  assert.deepEqual(window.followingItems.map((entry) => entry.id), ["p2"]);
});

test("with no in-progress item the first unfinished one focuses; an all-done list shows the last three", () => {
  const mixed = [item("d0", "done", "completed"), item("p0", "next", "pending"), item("p1", "later", "pending")];
  assert.equal(getStatusPanelTodoFocusWindow([...mixed, ...Array.from({ length: 5 }, (_, i) => item(`x${i}`, `x${i}`, "pending"))]).focusItems[0].id, "p0");

  const allDone = Array.from({ length: 8 }, (_, index) => item(`c${index}`, `c${index}`, "completed"));
  const tail = getStatusPanelTodoFocusWindow(allDone);
  assert.deepEqual(tail.focusItems.map((entry) => entry.id), ["c5", "c6", "c7"]);
});

/* ── Mini pill chain (C.6, reachable branches in order) ──────────────── */

test("the pill chain: current todo > active goal > completed item > counter > running works", () => {
  const currentTodo = buildStatusPanelModel({
    goal: goal(),
    todoItems: [item("a", "done", "completed"), item("b", "running step", "inProgress")],
    works: [work("bg-1", 1)],
    subagents: [subagent("s1")],
  });
  assert.deepEqual(getStatusPanelSummarySelection(currentTodo), { kind: "currentTodo", content: "running step" });

  const activeGoal = buildStatusPanelModel({ goal: goal("active"), todoItems: [], works: [], subagents: [] });
  assert.deepEqual(getStatusPanelSummarySelection(activeGoal), { kind: "activeGoal", title: "make the build green" });

  const pausedGoal = buildStatusPanelModel({ goal: goal("paused"), todoItems: [], works: [], subagents: [] });
  assert.equal(getStatusPanelSummarySelection(pausedGoal).kind, "activeGoal");

  const completed = buildStatusPanelModel({ goal: null, todoItems: [item("a", "finished", "completed")], works: [], subagents: [] });
  assert.deepEqual(getStatusPanelSummarySelection(completed), { kind: "completedTodo", content: "finished" });

  // A plan with only completed items takes the completed-item branch; the
  // counter branch below it stays as the chain's verbatim last plan fallback
  // (unreachable while every item is completed OR unfinished — kept 1:1).
  const allDone = buildStatusPanelModel({ goal: null, todoItems: [item("a", "one", "completed")], works: [], subagents: [] });
  assert.deepEqual(getStatusPanelSummarySelection(allDone), { kind: "completedTodo", content: "one" });

  const running = buildStatusPanelModel({ goal: null, todoItems: [], works: [work("bg-1", 1)], subagents: [subagent("s1")] });
  assert.deepEqual(getStatusPanelSummarySelection(running), { kind: "runningWorks", bashCount: 1, subagentCount: 1 });

  assert.equal(getStatusPanelSummarySelection(buildStatusPanelModel({ goal: null, todoItems: [], works: [], subagents: [] })), null);
});

/* ── Elapsed vocabulary (A.3/C.5) ────────────────────────────────────── */

test("work-row elapsed labels and section duration units", () => {
  assert.equal(formatBackgroundTaskElapsedLabel(0, t), "Running for 1s");
  assert.equal(formatBackgroundTaskElapsedLabel(41_500, t), "Running for 41s");
  assert.equal(formatBackgroundTaskElapsedLabel(101_000, t), "Running for 1m 41s");
  assert.equal(formatDurationUnits(0, t), "0s");
  assert.equal(formatDurationUnits(59, t), "59s");
  assert.equal(formatDurationUnits(61, t), "1m 1s");
  assert.equal(formatDurationUnits(3_723, t), "1h 2m 3s");
});

/* ── Composer badge counts (A.1) ─────────────────────────────────────── */

test("badge counts stay zero-sum over the three kinds and the tooltip picks one word", () => {
  const counts = getComposerBackgroundWorkCounts(2, 3, 0);
  assert.deepEqual(counts, { bashCount: 2, workflowCount: 0, subagentCount: 3, totalCount: 5 });
  assert.equal(composerBackgroundWorkTooltipKey(counts), "chat.composer.backgroundWorks.tooltipMixed");
  assert.equal(composerBackgroundWorkTooltipKey(getComposerBackgroundWorkCounts(1, 0, 0)), "chat.composer.backgroundWorks.tooltipTerminal");
  assert.equal(composerBackgroundWorkTooltipKey(getComposerBackgroundWorkCounts(0, 2, 0)), "chat.composer.backgroundWorks.tooltipAgent");
  assert.equal(composerBackgroundWorkTooltipKey(getComposerBackgroundWorkCounts(0, 0, 1)), "chat.composer.backgroundWorks.tooltipWorkflow");
});

test("the badge renders nothing without a handler or with nothing running", () => {
  assert.equal(render(React.createElement(BackgroundWorkBadges, { runningBashCount: 2 })).length, 0);
  assert.equal(render(React.createElement(BackgroundWorkBadges, { runningBashCount: 0, onOpen: () => {} })).length, 0);
});

test("the badge anatomy: typed icon+count spans, data attributes, compact twin", () => {
  const html = render(React.createElement(BackgroundWorkBadges, { runningBashCount: 2, runningSubagentCount: 1, onOpen: () => {} }));
  assert.match(html, /data-composer-background-layout="typed"/);
  assert.match(html, /data-composer-background-layout="compact"/);
  assert.equal((html.match(/data-background-bash-count="2"/g) ?? []).length, 1);
  assert.match(html, /data-background-subagent-count="1"/);
  assert.match(html, /data-background-total-count="3"/);
  // typed layout: terminal first, then agent (the workflow slot stays empty)
  assert.ok(html.indexOf("SquareTerminal") === -1); // icons carry no class names — count the svgs instead
  assert.equal((html.match(/<svg/g) ?? []).length, 3); // terminal + bot icons, compact activity icon
});

/* ── Panel shell + sections (C.2/C.3) ────────────────────────────────── */

test("the panel renders the aside shell with variant state and its sections in order", () => {
  const html = render(React.createElement(ConversationStatusPanel, {
    goal: goal(),
    todoItems: [item("a", "step one", "completed"), item("b", "step two", "inProgress")],
    works: [work("bg-9", Date.now() - 90_000)],
    subagents: [subagent("s1", Date.now() - 5_000)],
    parentSessionId: "parent",
    variantOverride: "panel",
    onVariantChange: () => {},
    onOpenBackgroundBash: () => {},
    onOpenSubagentSession: () => {},
  }));
  assert.match(html, /<aside aria-label="Status"/);
  assert.match(html, /data-testid="chat-summary-panel"/);
  assert.match(html, /data-state="expanded"/);
  assert.match(html, /data-display-mode="panel"/);
  assert.match(html, /data-running-terminal-count="1"/);
  assert.match(html, /data-running-agent-count="1"/);
  // Section order: Goal → Todo → Terminals → Agents (git/sessionPlans/workflows
  // have no data on our runtime).
  const goalAt = html.indexOf('data-status-section="goal"');
  const todoAt = html.indexOf('data-status-section="plan"');
  const terminalsAt = html.indexOf('data-status-section="terminal"');
  const agentsAt = html.indexOf('data-status-section="agent"');
  assert.ok(goalAt !== -1 && todoAt > goalAt && terminalsAt > todoAt && agentsAt > terminalsAt, "section order");
  // Headers are title-button-only collapses with the hover chevron indicator.
  assert.match(html, /aria-expanded="true" data-status-section-trigger="plan"/);
  assert.match(html, /status-section-chevron/);
  // Work rows: transparent overlay open-button + content (A.3).
  assert.match(html, /data-testid="background-bash-open"/);
  assert.match(html, /data-testid="background-subagent-open"/);
  assert.match(html, /status-work-overlay/);
  // The toolbar carries the mode-menu trigger (the dropdown itself opens on
  // click) and the collapse button (C.2).
  assert.match(html, /aria-label="Status panel display mode"/);
  assert.match(html, /aria-label="Collapse to capsule"/);
});

test("the mini variant renders the pill, not the body", () => {
  const html = render(React.createElement(ConversationStatusPanel, {
    goal: null,
    todoItems: [item("a", "current step", "inProgress")],
    works: [],
    subagents: [],
    variantOverride: "mini",
    onVariantChange: () => {},
  }));
  assert.match(html, /data-state="collapsed"/);
  assert.doesNotMatch(html, /status-panel-body/);
  // Pill branch 2: the current todo item with the ArrowRight metric.
  assert.match(html, /status-pill-trigger/);
  assert.match(html, /status-summary-text">current step</);
});

test("the fold rows appear for a compacted todo list and preview on open", () => {
  const items = [
    ...Array.from({ length: 5 }, (_, index) => item(`d${index}`, `done ${index}`, "completed")),
    item("run", "current step", "inProgress"),
    ...Array.from({ length: 3 }, (_, index) => item(`p${index}`, `pending ${index}`, "pending")),
  ];
  const html = render(React.createElement(ConversationStatusPanel, {
    goal: null,
    todoItems: items,
    works: [],
    subagents: [],
    variantOverride: "panel",
    onVariantChange: () => {},
  }));
  assert.match(html, /data-status-todo-preview-trigger="preceding"/);
  assert.match(html, /data-status-todo-preview-trigger="following"/);
  // Closed previews render no popover content; the trigger labels carry counts.
  assert.doesNotMatch(html, /status-todo-preview-content/);
  assert.match(html, /status-todo-fold-label">5 completed</);
  assert.match(html, /status-todo-fold-label">1 waiting</);
});

test("the goal section carries the pause/resume control wired to /goal commands", () => {
  const commands = [];
  const active = render(React.createElement(ConversationStatusPanel, {
    goal: goal("active"),
    todoItems: [],
    works: [],
    subagents: [],
    variantOverride: "panel",
    onVariantChange: () => {},
    onGoalCommand: (command) => commands.push(command),
  }));
  assert.match(active, /data-goal-action="pause"/);
  const paused = render(React.createElement(ConversationStatusPanel, {
    goal: goal("paused"),
    todoItems: [],
    works: [],
    subagents: [],
    variantOverride: "panel",
    onVariantChange: () => {},
    onGoalCommand: (command) => commands.push(command),
  }));
  assert.match(paused, /data-goal-action="resume"/);
  // The goal renders as one iteration-style row with rounds/cap.
  assert.match(paused, /data-goal-iteration="3"/);
  assert.match(paused, /status-goal-counter">3\/20</);
});

test("an agent row without a parent session renders no open overlay", () => {
  const html = render(React.createElement(ConversationStatusPanel, {
    goal: null,
    todoItems: [],
    works: [],
    subagents: [subagent("s1", Date.now())],
    variantOverride: "panel",
    onVariantChange: () => {},
    onOpenSubagentSession: () => {},
  }));
  assert.doesNotMatch(html, /background-subagent-open/);
  assert.match(html, /data-child-session-id|status-work-row/);
});

/* ── Bash follow semantics (A.4) ─────────────────────────────────────── */

test("follow decision: scrolling up freezes, reaching the bottom resumes", () => {
  assert.equal(nextBashFollowAction(true, false, true), "pause");
  assert.equal(nextBashFollowAction(true, false, false), null);
  assert.equal(nextBashFollowAction(true, true, true), null);
  assert.equal(nextBashFollowAction(false, true, false), "resume");
  assert.equal(nextBashFollowAction(false, false, true), null);
});

test("the bash pane renders raw text output in a mono pre, not markdown", () => {
  const html = render(React.createElement(BackgroundBashOutput, {
    sessionId: "s1",
    jobId: "bg-1",
    title: "npm test",
    visible: true,
  }));
  assert.match(html, /data-testid="background-bash-details"/);
  assert.match(html, /background-bash-output/);
  assert.match(html, /background-bash-statusbar/);
  // Following starts true: no resume arrow, and a fetch never ran server-side.
  assert.doesNotMatch(html, /background-bash-resume/);
  assert.match(html, /<pre[^>]*class="background-bash-output"/);
});
