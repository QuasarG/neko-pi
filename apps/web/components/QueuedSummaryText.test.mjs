import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  QueuedSummaryText,
  admitQueuedSummary,
  initialQueuedSummaryRollState,
  reduceQueuedSummaryRoll,
  resolveQueuedSummaryPlaybackQueue,
  SUMMARY_ROLL_HOLD_MS,
  SUMMARY_ROLL_TOTAL_MS,
  SUMMARY_ROLL_TRANSITION_MS,
} = await jiti.import("./QueuedSummaryText.tsx");

function render(props) {
  return renderToStaticMarkup(React.createElement(QueuedSummaryText, props));
}

const snap = (key, text = key) => ({ key, text });

test("timing constants match the catalog (§2.3/§5): 300ms roll + 500ms hold", () => {
  assert.equal(SUMMARY_ROLL_TRANSITION_MS, 300);
  assert.equal(SUMMARY_ROLL_HOLD_MS, 500);
  assert.equal(SUMMARY_ROLL_TOTAL_MS, 800);
});

test("a timer drift past 250ms flushes a multi-entry queue to its newest entry", () => {
  const queue = ["a", "b", "c"];
  assert.deepEqual(resolveQueuedSummaryPlaybackQueue(queue, 100), queue);
  assert.deepEqual(resolveQueuedSummaryPlaybackQueue(queue, 250), queue);
  // Drift: the backlog is stale; only the newest value is worth showing.
  assert.deepEqual(resolveQueuedSummaryPlaybackQueue(queue, 251), ["c"]);
  // A single pending entry always plays, however late the timer fired.
  assert.deepEqual(resolveQueuedSummaryPlaybackQueue(["only"], 5_000), ["only"]);
});

test("queue admission: same-key updates its slot; cap 2; the first slot is never replaced", () => {
  // Empty queue: the newcomer takes the (only) slot.
  assert.deepEqual(admitQueuedSummary([], snap("a")), [snap("a")]);

  // Occupied: the newcomer takes the cut-in slot, queue caps at 2 pending.
  assert.deepEqual(admitQueuedSummary([snap("a")], snap("b")), [snap("a"), snap("b")]);
  assert.deepEqual(admitQueuedSummary([snap("a"), snap("b")], snap("c")), [snap("a"), snap("c")]);

  // The first queued entry is never displaced — only the second slot turns over.
  assert.deepEqual(admitQueuedSummary([snap("a"), snap("b")], snap("d")), [snap("a"), snap("d")]);

  // A snapshot already waiting updates its own slot in place, never stacks.
  const updatedA = { key: "a", text: "a-v2" };
  assert.deepEqual(admitQueuedSummary([snap("a"), snap("b")], updatedA), [updatedA, snap("b")]);
});

test("lifecycle: the first value never rolls; a key change promotes with the entrance flag", () => {
  let state = initialQueuedSummaryRollState(snap("a", "first"));
  assert.equal(state.rolledIn, false, "initial mount has no entrance (initial={false})");
  assert.equal(state.exiting, null);

  // Same key, new text: an in-place refresh, never a roll.
  state = reduceQueuedSummaryRoll(state, { type: "content", snapshot: snap("a", "first+more"), animate: true });
  assert.equal(state.rolledIn, false);
  assert.equal(state.displayed.text, "first+more");
  assert.equal(state.exiting, null);
  assert.equal(state.rolling, false);

  // Different key: promote — the incoming line carries data-roll="in", the
  // old line becomes the exiting (data-roll="out") item.
  state = reduceQueuedSummaryRoll(state, { type: "content", snapshot: snap("b", "second"), animate: true });
  assert.equal(state.rolledIn, true, "the promoted item must roll in from below");
  assert.equal(state.displayed.key, "b");
  assert.equal(state.exiting.key, "a");
  assert.equal(state.rolling, true);
});

test("lifecycle: changes during a roll queue; the timer plays them; the exit clears", () => {
  let state = initialQueuedSummaryRollState(snap("a"));
  state = reduceQueuedSummaryRoll(state, { type: "content", snapshot: snap("b"), animate: true });

  // Three changes while the roll plays: b shows, c is next, d cut in over e.
  state = reduceQueuedSummaryRoll(state, { type: "content", snapshot: snap("c"), animate: true });
  state = reduceQueuedSummaryRoll(state, { type: "content", snapshot: snap("d"), animate: true });
  state = reduceQueuedSummaryRoll(state, { type: "content", snapshot: snap("e"), animate: true });
  assert.deepEqual(state.queued.map((item) => item.key), ["c", "e"], "cap 2, first slot kept, d replaced by e");

  // The hold elapses with only mild drift: the first queued entry plays.
  state = reduceQueuedSummaryRoll(state, { type: "timer", timerDriftMs: 100 });
  assert.equal(state.displayed.key, "c");
  assert.equal(state.exiting.key, "b");
  assert.equal(state.rolling, true, "queued playback starts the next roll");
  assert.deepEqual(state.queued.map((item) => item.key), ["e"]);

  // A late timer flushes what is left straight to the newest entry.
  state = reduceQueuedSummaryRoll(state, { type: "timer", timerDriftMs: 5_000 });
  assert.equal(state.displayed.key, "e");

  // Nothing queued: the timer ends the rolling window.
  state = reduceQueuedSummaryRoll(state, { type: "timer", timerDriftMs: 0 });
  assert.equal(state.rolling, false);
  assert.deepEqual(state.queued, []);

  // The out-item leaves once its 300ms elapse.
  state = reduceQueuedSummaryRoll(state, { type: "exit-done" });
  assert.equal(state.exiting, null);
});

test("lifecycle: animation switching off lands the newest value in place and drops the backlog", () => {
  let state = initialQueuedSummaryRollState(snap("a"));
  state = reduceQueuedSummaryRoll(state, { type: "content", snapshot: snap("b"), animate: true });
  state = reduceQueuedSummaryRoll(state, { type: "content", snapshot: snap("c"), animate: true });
  assert.equal(state.queued.length, 1);

  // The row expands (enabled=false): no roll, no backlog, no entrance flag.
  state = reduceQueuedSummaryRoll(state, { type: "content", snapshot: snap("c"), animate: false });
  assert.equal(state.rolledIn, false);
  assert.equal(state.rolling, false);
  assert.equal(state.exiting, null);
  assert.deepEqual(state.queued, []);
  assert.equal(state.displayed.key, "c");

  // A stray timer after the reset changes nothing.
  const afterReset = reduceQueuedSummaryRoll(state, { type: "timer", timerDriftMs: 0 });
  assert.equal(afterReset, state);
});

test("renders the summary inside the rolling wrapper; the first mount carries no data-roll", () => {
  const html = render({ contentKey: "call-1:running", text: "src/index.ts", className: "tool-summary-text" });
  assert.match(html, /class="tool-summary-roll tool-summary-text"/);
  assert.match(html, /class="tool-summary-roll-item">src\/index\.ts</);
  // AnimatePresence initial={false}: the entrance attribute appears only on a
  // promoted value (asserted on the reducer state above), never on mount.
  assert.doesNotMatch(html, /data-roll/);
});

test("an empty summary renders nothing — no empty flex slot between kind and chevron", () => {
  assert.equal(render({ contentKey: "call-1:done", text: "" }), "");
  assert.equal(render({ contentKey: "call-1:done", text: null }), "");
});
