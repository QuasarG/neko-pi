import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  turnNavigatorBarVisualState,
  resolveActiveTurnNavigatorIndex,
} = await jiti.import("./ConversationTurnNavigator.tsx");

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// The wave table is ZCode's resolveConversationTurnNavigatorBarVisualState
// verbatim (conversationTurnNavigatorHelpers.ts:488-507): idle .58/1, peak
// 1/2.6 in the focus ink, near .86/1.7, mid .72/1.25, back to idle beyond 2.
test("bar visual state matches ZCode's wave table", () => {
  assert.deepEqual(turnNavigatorBarVisualState(undefined), {
    colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle",
  });
  assert.deepEqual(turnNavigatorBarVisualState(0), {
    colorTone: "focus", opacity: 1, scaleX: 2.6, tone: "peak",
  });
  assert.deepEqual(turnNavigatorBarVisualState(1), {
    colorTone: "muted", opacity: 0.86, scaleX: 1.7, tone: "near",
  });
  assert.deepEqual(turnNavigatorBarVisualState(2), {
    colorTone: "muted", opacity: 0.72, scaleX: 1.25, tone: "mid",
  });
  assert.deepEqual(turnNavigatorBarVisualState(3), {
    colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle",
  });
  assert.deepEqual(turnNavigatorBarVisualState(9), {
    colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle",
  });
});

// Active = the LAST query whose top sits above scrollTop + 120px; none yet
// falls back to the first rendered query.
test("active index is the last query above the viewport line", () => {
  const roots = [
    { itemIndex: 0, offsetTop: 0 },
    { itemIndex: 1, offsetTop: 800 },
    { itemIndex: 2, offsetTop: 2000 },
  ];
  assert.equal(resolveActiveTurnNavigatorIndex(roots, 0), 0);
  // 800 <= 700 + 120 → still query 1 at a scroll of 700.
  assert.equal(resolveActiveTurnNavigatorIndex(roots, 700), 1);
  // 1870 + 120 = 1990 < 2000: the third query is still below the line.
  assert.equal(resolveActiveTurnNavigatorIndex(roots, 1870), 1);
  assert.equal(resolveActiveTurnNavigatorIndex(roots, 2000), 2);
  // Nothing above the line: the first rendered query stays active.
  assert.equal(
    resolveActiveTurnNavigatorIndex([{ itemIndex: 3, offsetTop: 5000 }], 0),
    3,
  );
  assert.equal(resolveActiveTurnNavigatorIndex([], 0), -1);
});

test("the navigator renders queries only and hides under two turns (source pins)", () => {
  const source = read("./ConversationTurnNavigator.tsx");
  // R36 (user order 2026-11-01): the rail lists queries only; the hover card
  // additionally previews the turn's final summary reply.
  assert.match(source, /data-turn-navigator-card/);
  assert.match(source, /assistantPreview/);
  assert.match(source, /conversation-turn-navigator-card-preview/);
  // The hover card timings and the reduced-motion scroll behavior.
  assert.match(source, /CARD_OPEN_DELAY_MS = 120/);
  assert.match(source, /CARD_CLOSE_DELAY_MS = 80/);
  assert.match(source, /prefersReducedMotion \? "auto" : "smooth"/);
  // The rail's active item is kept in view without smooth scrolling.
  assert.match(source, /scrollIntoView\(\{ block: "nearest" \}\)/);
  // Keyboard focus mirrors hover: focus reveals the rail and the wave.
  assert.match(source, /onFocus=\{\(\) => \{/);
  // Escape clears the interaction state.
  assert.match(source, /event\.key !== "Escape"/);
});

test("S1.2: ChatWindow feeds the navigator user queries and jumps to their elements", () => {
  const chatWindow = read("./ChatWindow.tsx");
  // Items come from role==="user" messages via getUserInputText (empty skip).
  assert.match(chatWindow, /const text = getUserInputText\(message\);/);
  assert.match(chatWindow, /if \(text === null\) return;/);
  // The jump resolves the user root by entry id, else by suffix ordinal.
  assert.match(chatWindow, /\[data-message-role="user"\]\[data-entry-id="\$\{CSS\.escape\(item\.entryId\)\}"\]/);
  assert.match(chatWindow, /querySelectorAll<HTMLElement>\('\[data-message-role="user"\]'\)/);
  // A query above the rendered window pages history in before scrolling.
  assert.match(chatWindow, /setVisibleCount\(\(current\) => Math\.max\(current, messages\.length \* 2\)\);/);
});
