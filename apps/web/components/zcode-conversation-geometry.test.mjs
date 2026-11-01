import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Wave P pins the measured deltas that made the live page read unlike ZCode:
// one column for the composer and the transcript, 16px-root px values where
// the copied Tailwind used rem, and the digest/tool row anatomy. R24 pins the
// card's overlay ruling: the column never shifts for it and the host clears
// the trajectory rail. These are source-text assertions because ChatWindow
// imports Next-only modules and the repo has no DOM environment.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const chatWindow = read("./ChatWindow.tsx");
// R47: the digest band moved to its own module (the subagent viewer folds with it).
const processGroup = read("./ProcessDetailsGroup.tsx");
const chatInput = read("./ChatInput.tsx");
const conversationCss = read("../app/conversation.css");
const globalsCss = read("../app/globals.css");

test("R22: the message column carries the 24px text padding inside its width cap", () => {
  assert.match(chatWindow, /maxWidth: "var\(--chat-content-adaptive-width, var\(--chat-content-max-width, 820px\)\)", margin: "0 auto", paddingInline: 24/);
});

test("R24: the status card is a pure overlay — the column never shifts for it", () => {
  assert.doesNotMatch(chatWindow, /statusPanelLayoutClass/);
  assert.doesNotMatch(chatWindow, /conversation-status-offset/);
  assert.doesNotMatch(conversationCss, /translateX\(-168px\)/);
});

test("R22/R24: the composer dock keeps 8px padding and never re-anchors its menus", () => {
  // No container on the dock: container-type would impose layout containment
  // and re-anchor the model selector's position:fixed panel off-viewport.
  assert.doesNotMatch(conversationCss, /\.composer-dock\s*\{[^}]*container/);
  assert.match(chatInput, /paddingInline: 8/);
  // S1.2: the old 36px minimap rail reservation on the composer fieldset is
  // gone — the capped box centres with the scroll column, both full width.
  assert.match(chatInput, /padding: 0,/);
  // S1.2: the card host's rail clearance defaults to 0 (card right 16); the
  // inline var is gone from ChatWindow entirely.
  assert.doesNotMatch(chatWindow, /status-panel-rail/);
  assert.doesNotMatch(chatWindow, /CHAT_MINIMAP_WIDTH/);
  assert.match(conversationCss, /right: calc\(16px \+ var\(--status-panel-rail, 0px\)\)/);
  assert.match(conversationCss, /padding-inline: 16px calc\(16px \+ var\(--status-panel-rail, 0px\)\)/);
});

test("R22: the adaptive cap is ZCode's max-w-6xl 1152, not 1080", () => {
  assert.match(globalsCss, /min\(72vw, 1152px\)/);
  assert.doesNotMatch(globalsCss, /min\(72vw, 1080px\)/);
});

test("R22: every rem copied from ZCode's 16px root is written in px", () => {
  assert.doesNotMatch(stripComments(conversationCss), /\drem\b/);
  assert.match(conversationCss, /max-width: min\(320px, calc\(100cqw - 32px\)\)/);
  assert.match(conversationCss, /max-height: min\(64dvh, 512px\); width: 320px/);
  assert.match(conversationCss, /max-height: min\(384px, calc\(100dvh - 32px\)\)/);
});

test("R23c: the digest is ZCode's AssistantHistoryStatus band, not a count line", () => {
  // Body-size "Worked for {time}" copy, localized; counts only in the a11y text.
  assert.match(processGroup, /t\("chat\.workedFor", \{ time: formatTurnDuration\(durationMs\) \}\)/);
  assert.match(processGroup, /t\("chat\.worked"\)/);
  assert.match(processGroup, /borderBottom: "1px solid color-mix\(in srgb, var\(--border\) 50%, transparent\)"/);
  assert.match(processGroup, /paddingBottom: 8,/);
  assert.match(processGroup, /aria-label=\{`\$\{t\("chat\.processDetails"\)\} · \$\{countsText\}`\}/);
  assert.match(processGroup, /title=\{countsText\}/);
  // The visible label is the duration label alone.
  assert.match(processGroup, /\{label\}/);
  assert.doesNotMatch(processGroup, /parts\.join\(" · "\)\}/);
  // The fold body is pt-5 and carries no horizontal padding.
  assert.match(conversationCss, /\.process-details-inner \{ padding-top: 20px; \}/);
  assert.match(conversationCss, /\.process-details-body \{ margin-top: 0; padding-left: 0; flex-basis: 100%; \}/);
  // R30: same-family call runs MERGE (ZCode executeGroup & co) — one group
  // row while collapsed; children ride the nesting rail and drop their icon.
  assert.match(chatWindow, /import \{ ToolCallGroupCard, countToolCallRun, toolCallFamily, type ToolCallFamily \} from \"\.\/ToolCallGroupCard\";/);
  assert.match(conversationCss, /\.tool-call-group-children \{ margin: 0 0 0 8px; padding-left: 14px; border-left: 1px solid var\(--border\); \}/);
  assert.match(conversationCss, /\.tool-call-group-children \.tool-glyph-slot \{ display: none; \}/);
  // R31: the fold is one flex column on ZCode's gap-4 — identical 16px
  // rhythm within a message and between calls; step margins stay dead.
  assert.match(conversationCss, /\.process-details-inner \{ display: flex; flex-direction: column; gap: 16px; \}/);
  assert.match(conversationCss, /\.process-details-inner \[data-message-role\] \{ margin-bottom: 0 !important; \}/);
  assert.doesNotMatch(conversationCss, /\[data-message-role\] > div \{ gap: 8px/);
  // ZCode's hideAssistantActions={!item.latest}: every process-fold segment
  // renders without the actions row, so no 24px dead space per reply.
  assert.match(chatWindow, /showActions: false,/);
  assert.match(chatWindow, /showActions=\{options\.showActions\}/);
});

test("R23d: tool rows are 24px, unindented, and carry no duration", () => {
  assert.match(conversationCss, /\.tool-summary \{[\s\S]*?padding: 0; min-height: 24px;/);
  assert.doesNotMatch(conversationCss, /\.tool-call-card \.tool-summary \{ flex: 1/);
  assert.doesNotMatch(chatWindow, /duration !== undefined && <span className="tool-status">/);
  // Scoped ink tokens (60% / 40%, 30% on dark) instead of the solid #666.
  assert.match(conversationCss, /--conversation-ink-subtle: color-mix\(in oklab, var\(--text\) 60%, transparent\)/);
  assert.match(conversationCss, /--conversation-ink-subtlest: color-mix\(in oklab, var\(--text\) 40%, transparent\)/);
  assert.match(conversationCss, /--conversation-ink-subtlest: color-mix\(in oklab, var\(--text\) 30%, transparent\)/);
});

test("S1.4: the process fold body always takes the full band line", () => {
  // Root cause fix: the band is a wrap flex row with justify-content
  // space-between and the body used to size to its content — a fold narrow
  // enough to fit beside the digest trigger was pushed to the RIGHT edge.
  assert.match(conversationCss, /\.process-details-body \{ margin-top: 0; padding-left: 0; flex-basis: 100%; \}/);
});

test("S1.1/S1.2: the left turn navigator replaces the right minimap", () => {
  const navigatorSource = read("./ConversationTurnNavigator.tsx");
  const minimapGone = read("./ChatWindow.tsx");
  // ZCode anatomy (ConversationTurnNavigator.tsx): nav w-12 z-10, rail
  // left-3 centered with the 96px cap, 10x36 items, 2x12 bars, the wave
  // state table verbatim, hover card 320px/12px pad/open 120ms/close 80ms.
  assert.match(conversationCss, /\.conversation-turn-navigator \{\s*position: absolute; inset-block: 0; left: 0; z-index: 10;/);
  assert.match(conversationCss, /width: 48px; pointer-events: none;/);
  assert.match(conversationCss, /position: absolute; left: 12px; top: 50%;/);
  assert.match(conversationCss, /max-height: calc\(100% - 96px\); width: 36px;/);
  assert.match(conversationCss, /width: 36px; height: 10px;/);
  assert.match(conversationCss, /display: block; width: 12px; height: 2px;/);
  assert.match(navigatorSource, /opacity: 0\.58, scaleX: 1, tone: "idle"/);
  assert.match(navigatorSource, /opacity: 1, scaleX: 2\.6, tone: "peak"/);
  assert.match(navigatorSource, /opacity: 0\.86, scaleX: 1\.7, tone: "near"/);
  assert.match(navigatorSource, /opacity: 0\.72, scaleX: 1\.25, tone: "mid"/);
  assert.match(navigatorSource, /CARD_OPEN_DELAY_MS = 120/);
  assert.match(navigatorSource, /CARD_CLOSE_DELAY_MS = 80/);
  assert.match(conversationCss, /width: 320px; max-width: calc\(100vw - 32px\);/);
  assert.match(conversationCss, /padding: 12px;/);
  assert.match(conversationCss, /border: 1px solid var\(--border\); border-radius: var\(--radius-xl\);/);
  // Hidden by default; revealed by the gutter pointer / keyboard focus; only
  // from 864px of conversation width; fewer than 2 queries renders nothing.
  assert.match(navigatorSource, /GUTTER_REVEAL_PX = 56/);
  assert.match(navigatorSource, /addEventListener\("pointermove", onPointerMove\)/);
  assert.match(navigatorSource, /setRevealed\(true\)/);
  assert.match(conversationCss, /\.conversation-turn-navigator\[data-revealed\],\n\.conversation-turn-navigator:focus-within \{/);
  assert.match(conversationCss, /@container conversation \(max-width: 863px\)/);
  assert.match(navigatorSource, /if \(items\.length < 2\) return null;/);
  // The minimap is gone: no component, no import, user-role anchors exist.
  assert.match(minimapGone, /import \{ ConversationTurnNavigator, type ConversationTurnNavigatorItem \} from "\.\/ConversationTurnNavigator";/);
  assert.doesNotMatch(minimapGone, /ChatMinimap/);
  assert.match(read("./MessageView.tsx"), /data-message-role="user"/);
});
