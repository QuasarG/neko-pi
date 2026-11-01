import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  CompactionSummaryDetails,
  MessageView,
  PatchDiffFiles,
  ThinkingBlock,
  formatToolDuration,
  getModelDisplayName,
  getTokenEstimateText,
  estimateStreamedTokens,
  estimateTokens,
  estimateUpdatedTokens,
  getToolCallInputText,
  replaceUserMessageText,
} = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { splitFinalAssistantBlocks } = await jiti.import("@/lib/message-display");
const { clearExpandedToolCalls, setToolCallExpanded } = await jiti.import("@/lib/tool-call-expansion");
const { parseUnifiedPatch } = await jiti.import("@/lib/patch");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("updates a reused message when its written files change", () => {
  const props = { message: { role: "assistant", content: [] } };
  assert.equal(MessageView.compare(props, props), true);
  assert.equal(MessageView.compare(props, { ...props, writtenFiles: [{ path: "/tmp/result.txt" }] }), false);
});

test("matches response model aliases and otherwise includes the provider", () => {
  const names = {
    "gateway:claude-sonnet-5": "Sonnet 5",
    "custom-api:GLM-5.3": "GLM 5.3",
  };

  assert.equal(getModelDisplayName("gateway", "anthropic/claude-sonnet-5", names), "Sonnet 5");
  assert.equal(getModelDisplayName("CUSTOM-API", "glm-5.3", names), "GLM 5.3");
  assert.equal(getModelDisplayName("gateway", "unknown-model", names), "gateway/unknown-model");
});

test("a done thinking row reads Thought · 3s; the text waits behind the toggle (§3)", () => {
  const previousWindow = globalThis.window;
  try {
    for (const expanded of [false, true]) {
      globalThis.window = { localStorage: { getItem: () => String(expanded) } };
      const html = renderToStaticMarkup(React.createElement(
        I18nProvider,
        null,
        React.createElement(ThinkingBlock, {
          block: { type: "thinking", thinking: "**Independent reasoning**\n\nDetailed second line." },
          blockIndex: 2,
          duration: 3,
        }),
      ));
      assert.match(html, new RegExp(`aria-expanded="${expanded}"`));
      // ZCode's finished row: "Thought · 3s", never a preview line.
      assert.match(html, />Thought</);
      assert.match(html, / · 3s</);
      assert.equal((html.match(/>[^<]*Independent reasoning[^<]*</g) ?? []).length, expanded ? 1 : 0);
      assert.equal(html.includes("Detailed second line."), expanded);
      // The preview stays readable to screen readers through the label.
      assert.match(html, /aria-label="Thinking: /);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("a streaming thinking row sweeps Thinking and rolls the last reasoning line (§3)", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ThinkingBlock, {
      block: { type: "thinking", thinking: "First candidate\n\nchecking the parser now" },
      streaming: true,
      blockIndex: 0,
    }),
  ));
  // The live label carries the running sweep; the collapsed row shows the
  // reasoning's last non-empty line, not the first.
  assert.match(html, /class="tool-kind animated-gradient-text">Thinking</);
  assert.match(html, /checking the parser now/);
  assert.doesNotMatch(html, />First candidate</);
  assert.match(html, /class="tool-chevron"/);
});

test("a streaming thinking block expanded shows Thought with live seconds, not the sweep (§3)", () => {
  const previousWindow = globalThis.window;
  try {
    globalThis.window = { localStorage: { getItem: () => "true" } };
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      null,
      React.createElement(ThinkingBlock, {
        block: { type: "thinking", thinking: "working through it" },
        streaming: true,
        blockIndex: 0,
      }),
    ));
    // reasoning.tsx:329-337: the sweep is the COLLAPSED streaming state;
    // expanded, the label is the completed shape with its ticking seconds
    // (1s at mount: ceil with a floor of 1) and no rolling preview line.
    assert.match(html, /aria-expanded="true"/);
    assert.doesNotMatch(html, /animated-gradient-text/);
    assert.match(html, />Thought</);
    assert.match(html, / · 1s</);
    assert.doesNotMatch(html, /reasoning-live-line/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("renders long expanded thinking in pieces and short thinking as one text node (#1196)", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { localStorage: { getItem: () => "true" } };
  const contentOf = (thinking) => {
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      null,
      React.createElement(ThinkingBlock, { block: { type: "thinking", thinking }, blockIndex: 0 }),
    ));
    return html.match(/overflow-wrap:anywhere">([\s\S]*)<\/div><\/div><\/div><\/div>$/)[1];
  };
  const piecesOf = (thinking) => {
    const content = contentOf(thinking);
    const pieces = [...content.matchAll(/<div>([^<]*)<\/div>/g)].map((match) => match[1]);
    assert.equal(pieces.map((piece) => `<div>${piece}</div>`).join(""), content);
    assert.ok(pieces.length > 1);
    return pieces;
  };
  try {
    assert.equal(contentOf("First <b>line</b>\n\nSecond line."), "First &lt;b&gt;line&lt;/b&gt;\n\nSecond line.");

    // The block boundary stands in for the line break at a cut; a line with
    // no break is cut with nothing left out.
    const thinking = "Wait, let me check settings.json again.\n".repeat(2_000);
    assert.equal(piecesOf(thinking).join("\n"), thinking);
    const oneLine = "Wait, let me check settings.json again. ".repeat(2_000);
    assert.equal(piecesOf(oneLine).join(""), oneLine);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("shows deferred thinking previews without loading the full content", () => {
  const html = renderMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: "Historical first line", deferred: true }],
  });
  // Collapsed (§3): no text in the row — the preview lives in the aria label
  // until the toggle loads the deferred content.
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="Thinking: Historical first line"/);
  assert.doesNotMatch(html, />Historical first line</);
});

test("keys an assistant message's blocks by their place, not the entry id (#1184)", () => {
  // A message of the running turn gets its entry id when the file is read again.
  // A block keyed by it remounted then: open thinking closed, a tool output's
  // scroll went back to the top. ThinkingBlock drops what it loaded for another id.
  const source = ts.createSourceFile("MessageView.tsx", readFileSync(new URL("./MessageView.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const keys = [];
  (function visit(node) {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(source) === "BlockView") {
      const key = node.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "key");
      keys.push(key?.initializer?.expression?.getText(source));
    }
    ts.forEachChild(node, visit);
  })(source);
  // R29 added the group-card path: children keep originalIndex; a single
  // (ungrouped) run keys by its first block's place. Both stay place-based.
  assert.deepEqual(keys, ["originalIndex", "runKey"]);
});

test("marks only the matched text block after splitting thinking and the final answer", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "Thinking about the result" },
      { type: "text", text: "Process text" },
      { type: "toolCall", toolCallId: "read-1", toolName: "read", input: {} },
      { type: "text", text: "First answer" },
      { type: "text", text: "Matched pi-cwd-spark answer" },
    ],
  };
  const { processBlocks, answerBlocks } = splitFinalAssistantBlocks(message);
  for (const index of [2, 4, 5]) {
    const searchBlock = message.content[index];
    for (const content of [processBlocks, answerBlocks]) {
      const html = renderMessage({ ...message, content }, { searchBlock });
      assert.equal((html.match(/data-search-target="true"/g) ?? []).length, content.includes(searchBlock) ? 1 : 0);
      if (content.includes(searchBlock)) {
        assert.match(html, new RegExp(`data-search-target="true">(?:(?!data-message-text)[\\s\\S])*${searchBlock.text}`));
      }
    }
  }
});

test("keeps streamed tool input out of collapsed markup while counting it", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-write-1",
    toolName: "write",
    input: {},
    rawInput: '{"path":"/tmp/file","content":"secret-stream-fragment',
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { isStreaming: true });

  assert.match(html, /Writing/);
  assert.match(html, /Generating parameters/);
  assert.doesNotMatch(html, /secret-stream-fragment/);
  assert.equal(getToolCallInputText(block), block.rawInput);
  assert.equal(getTokenEstimateText(block), block.rawInput);
});

test("renders write tool content as readable file text", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-write-file",
    toolName: "write",
    input: { path: "src/example.ts", content: "first line\nsecond line\n" },
  };
  clearExpandedToolCalls();
  setToolCallExpanded(block.toolCallId, true);
  try {
    const html = renderMessage({
      role: "assistant",
      provider: "anthropic",
      model: "claude-test",
      content: [block],
    });

    assert.ok(html.includes("src/example.ts"));
    assert.match(html, /first line\nsecond line\n/);
    assert.ok(!html.includes("<table"));
    assert.doesNotMatch(textOf(html), /"content":/);
  } finally {
    clearExpandedToolCalls();
  }
});

test("a write with another argument or an empty file shows every argument as a row", () => {
  const cases = [
    { id: "call-write-mode", input: { path: "notes.md", content: "text", mode: "append" }, expect: "append" },
    { id: "call-write-empty", input: { path: "empty.txt", content: "" }, expect: "(empty)" },
  ];
  for (const { id, input, expect } of cases) {
    const block = { type: "toolCall", toolCallId: id, toolName: "write", input };
    clearExpandedToolCalls();
    setToolCallExpanded(id, true);
    try {
      const html = renderMessage({ role: "assistant", provider: "anthropic", model: "claude-test", content: [block] });
      assert.ok(textOf(html).includes(expect), id);
      assert.doesNotMatch(textOf(html), /"path":/, id);
    } finally {
      clearExpandedToolCalls();
    }
  }
});

test("streaming input shows the rows pi's partial parse has so far, else its raw text", () => {
  const cases = [
    // A multi-line command cut mid-escape: its lines, not `\n` escapes.
    { id: "call-bash-streaming", toolName: "bash", rawInput: "{\"command\":\"cd /tmp\\nls -l\\", rows: ["command", "cd /tmp\nls -l"] },
    { id: "call-bash-timeout", toolName: "bash", rawInput: "{\"command\":\"sleep 5\",\"timeout\":3", rows: ["timeout", "3"] },
    // Nothing parsed yet, or a nested argument begun: the raw text, as before.
    { id: "call-bash-empty", toolName: "bash", rawInput: "{\"comm", rows: null },
    { id: "call-edit-streaming", toolName: "edit", rawInput: "{\"path\":\"a.ts\",\"edits\":[{\"oldText\":\"x", rows: null },
  ];
  for (const { id, toolName, rawInput, rows } of cases) {
    const block = { type: "toolCall", toolCallId: id, toolName, input: {}, rawInput };
    clearExpandedToolCalls();
    setToolCallExpanded(id, true);
    try {
      const html = renderMessage({ role: "assistant", provider: "anthropic", model: "claude-test", content: [block] });
      if (rows) {
        assert.ok(html.includes("<table"), id);
        for (const text of rows) assert.ok(textOf(html).includes(text), id);
      } else {
        assert.ok(!html.includes("<table"), id);
        assert.ok(textOf(html).includes(getToolCallInputText(block)), id);
      }
    } finally {
      clearExpandedToolCalls();
    }
  }
});

test("a nested argument keeps the JSON body: a row cannot hold a subtree", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-mcp-nested",
    toolName: "mcp__issues__search",
    input: { query: "open bugs", filter: { labels: ["bug"], assignee: "me" }, limit: 10 },
  };
  clearExpandedToolCalls();
  setToolCallExpanded(block.toolCallId, true);
  try {
    const html = renderMessage({ role: "assistant", provider: "anthropic", model: "claude-test", content: [block] });
    assert.ok(!html.includes("<table"));
    assert.ok(textOf(html).includes('"filter"'));
    assert.ok(textOf(html).includes('"labels"'));
  } finally {
    clearExpandedToolCalls();
  }
});

test("an edit call shows no table: its arguments are a list of patches", () => {
  const input = {
    path: "src/app/page.tsx",
    edits: [{ oldText: "const a = 1", newText: "const a = 2" }],
  };
  const block = { type: "toolCall", toolCallId: "call-edit-nested", toolName: "edit", input };
  clearExpandedToolCalls();
  setToolCallExpanded(block.toolCallId, true);
  try {
    const html = renderMessage({ role: "assistant", provider: "anthropic", model: "claude-test", content: [block] });
    assert.ok(!html.includes("<table"));
  } finally {
    clearExpandedToolCalls();
  }
});

test("a read, a subagent and a flat MCP call show one row per argument", (t) => {
  const cases = [
    { id: "call-read-rows", toolName: "read", input: { path: "lib/tool-fields.ts", offset: 120, limit: 80 }, expect: [">path</td>", "lib/tool-fields.ts", ">120</td>"] },
    { id: "call-agent-rows", toolName: "Agent", input: { subagent_type: "Explore", prompt: "Find the parser" }, expect: [">subagent_type</td>", "Find the parser"] },
    { id: "call-mcp-flat-rows", toolName: "mcp__issues__search", input: { query: "open bugs", limit: 10 }, expect: [">query</td>", "open bugs", ">10</td>"] },
  ];
  for (const { id, toolName, input, expect } of cases) {
    const block = { type: "toolCall", toolCallId: id, toolName, input };
    setToolCallExpanded(id, true);
    t.after(() => setToolCallExpanded(id, false));
    const html = renderMessage({ role: "assistant", provider: "anthropic", model: "claude-test", content: [block] });
    assert.ok(html.includes("<table"), id);
    for (const needle of expect) assert.ok(html.includes(needle), `${id}: ${needle}`);
  }
});

test("a long or multi-line value stays inside the card", (t) => {
  const content = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
  const block = {
    type: "toolCall",
    toolCallId: "call-agent-long",
    toolName: "Agent",
    input: { subagent_type: "a".repeat(200), prompt: content },
  };
  setToolCallExpanded(block.toolCallId, true);
  t.after(() => setToolCallExpanded(block.toolCallId, false));
  const html = renderMessage({ role: "assistant", provider: "anthropic", model: "claude-test", content: [block] });
  // A single-line value wraps in its cell; a value with lines of its own scrolls in a block.
  assert.ok(html.includes("<table"));
  assert.match(html, /overflow-wrap:anywhere/);
  // R21: the field rows' sizes ride the knob ladder (meta for values), never
  // a static offset.
  assert.match(html, /font-size:var\(--conversation-font-size-meta, calc\(var\(--chat-content-font-size, 16px\) - 2px\)\)/);
  assert.match(html, /max-height:260px/);
  assert.match(html, /overflow:auto/);
  assert.ok(textOf(html).includes("line 39"));
});

test("renders subagents as standard tool calls with only an extra side-panel button", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-agent-1",
    toolName: "Agent",
    input: {
      subagent_type: "Explore",
      prompt: "Find the parser",
      description: "Find parser",
    },
  };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "Parser is in lib/parser.ts" }],
    details: {
      kind: "pi-web-subagent",
      sessionId: "child-session",
      profile: "Explore",
      description: "Find parser",
      status: "completed",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, {
    toolResults: new Map([[block.toolCallId, result]]),
    onOpenSubagent() {},
  });

  assert.match(html, /class="tool-call-card"/);
  assert.match(html, />Agent</);
  assert.match(html, />Explore</);
  assert.match(html, /aria-label="View sub-agent work in side panel"/);
  assert.doesNotMatch(html, />completed</);
  assert.doesNotMatch(html, />Find parser</);

  const ordinaryHtml = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [{ ...block, toolCallId: "call-extension-1", toolName: "extension_tool" }],
  }, {
    toolResults: new Map(),
    onOpenSubagent() {},
  });
  assert.doesNotMatch(ordinaryHtml, /View sub-agent work in side panel/);
});

test("a tool card keeps the run time out of the row and shows it in the details", () => {
  const block = { type: "toolCall", toolCallId: "call-duration-1", toolName: "bash", arguments: { command: "make" } };
  const message = { role: "assistant", provider: "anthropic", model: "claude-test", content: [block], timestamp: 1_000_000, durationMs: 4_000 };
  const result = { role: "toolResult", toolCallId: block.toolCallId, toolName: "bash", content: [], isError: false };
  // R23d: ZCode's compact row carries no per-tool duration.
  clearExpandedToolCalls();
  const collapsed = renderMessage(message, { toolResults: new Map([[block.toolCallId, result]]) });
  assert.doesNotMatch(collapsed, /tool-duration/);
  assert.doesNotMatch(collapsed, /2\.4s/);
  const details = (toolResult) => {
    clearExpandedToolCalls();
    setToolCallExpanded(block.toolCallId, true);
    try {
      return renderMessage(message, { toolResults: new Map([[block.toolCallId, toolResult]]) });
    } finally {
      clearExpandedToolCalls();
    }
  };
  // pi 1.1 records the execution itself; the timestamps would count the model's 4 s of generation too.
  assert.match(details({ ...result, timestamp: 1_006_400, durationMs: 2_400 }), />Took 2\.4s</);
  // A result saved before pi recorded durations falls back to the timestamps.
  assert.match(details({ ...result, timestamp: 1_006_400 }), />Took 6\.4s</);
  assert.doesNotMatch(details({ ...result, timestamp: 1_006_400, durationMs: 40 }), /Took \d/);

  assert.equal(formatToolDuration(400), "0.4s");
  assert.equal(formatToolDuration(59_940), "59.9s");
  assert.equal(formatToolDuration(185_000), "3m 5s");
  assert.equal(formatToolDuration(3_725_000), "1h 2m 5s");
});

const COMPLETE_SKILL_EXPANSION = `<skill name="review" location="/skills/review/SKILL.md">
References are relative to /skills/review.

Review the supplied files.
</skill>

src/main.ts`;

test("a reply's usage line reads like pi's TUI footer, then the turn's time", () => {
  const usage = { input: 1_234, output: 567, cacheRead: 85_312, cacheWrite: 12, cost: { total: 0.00362 } };
  const html = renderMessage(
    { role: "assistant", provider: "anthropic", model: "claude-test", content: [{ type: "text", text: "Done." }], stopReason: "stop", usage },
    { turnDurationMs: 10_000 },
  );
  // The arrows and the clock are drawn as SVG; their characters and words stay
  // as font-size 0 text, so a copied selection reads like the footer.
  assert.equal(html.match(/<svg[^>]*aria-hidden="true"/g)?.length, 3);
  const text = html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<span style="font-size:0">([^<]*)<\/span>/g, "$1");
  // Each count is its own span; the spaces between them stay in the text.
  assert.match(text, /<span>↑1\.2k<\/span> <span>↓567<\/span> <span>R85k<\/span> <span>W12<\/span> <span>\$0\.0036<\/span> <span>·<\/span> <span>took 10s<\/span>/);
  // Zero counts are left out, as in the footer.
  const bare = renderMessage({
    role: "assistant", provider: "anthropic", model: "claude-test", content: [{ type: "text", text: "Done." }], stopReason: "stop",
    usage: { input: 12_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  });
  assert.match(bare.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<span style="font-size:0">([^<]*)<\/span>/g, "$1"), /<span>↑12M<\/span><\/div>/);
});

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders a truncation notice for stopReason length", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [{ type: "thinking", thinking: "Long reasoning chain" }],
    stopReason: "length",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /output limit was reached before an answer/i);
  assert.doesNotMatch(html, /follow-up/i);
});

test("keeps the follow-up hint when a truncated response already has text", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [{ type: "text", text: "Partial answer" }],
    stopReason: "length",
  });

  assert.match(html, /Partial answer/);
  assert.match(html, /follow-up/i);
  assert.doesNotMatch(html, /Compact context/);
});

test("a truncated unanswered reply keeps its notice and error, with no compaction offer (R16)", () => {
  // R16 removed the manual compaction triggers: ChatWindow no longer passes
  // onCompact, so the notice carries the error alone and offers no button.
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [],
    stopReason: "length",
  }, {
    compactError: "Summarization failed: generation hit the token cap",
  });

  assert.doesNotMatch(html, /Compact context|chat\.compactContext/);
  assert.match(html, /generation hit the token cap/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("marks persisted assistant messages with their source entry", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Select this response" }],
  }, { entryId: "assistant-entry" });

  assert.match(html, /data-message-role="assistant"/);
  assert.match(html, /data-entry-id="assistant-entry"/);
});

test("R49: a plain typed slash command renders as the icon chip, not bare text", () => {
  const html = renderMessage({ role: "user", content: "/goal fix the build" });
  assert.match(html, /user-command-chip/);
  assert.match(html, /user-command-chip-name">\/goal</);
  assert.match(html, /user-command-chip-args">fix the build</);
  assert.doesNotMatch(html, /markdown-user-message/);
});

test("R61: the streaming estimate counts CJK per character and other text per quarter", () => {
  // 4 CJK characters, 8 ASCII characters (4 tokens by the 4-chars/token rule).
  assert.equal(estimateTokens("一二三四abcdefgh"), 6);
  // A delta extends the counted text instead of recounting it.
  const first = { text: "hello", tokens: estimateTokens("hello") };
  assert.equal(estimateUpdatedTokens(first, "hello world"), first.tokens + estimateTokens(" world"));
  // Not a prefix (a rewrite) recount from scratch.
  assert.equal(estimateUpdatedTokens(first, "goodbye"), estimateTokens("goodbye"));
  // Streamed blocks keep their own cache entry, keyed by the content index.
  const items = [
    { block: { type: "text", text: "hello" }, originalIndex: 0 },
    { block: { type: "thinking", thinking: "想" }, originalIndex: 2 },
    { block: { type: "toolCall", toolCallId: "t", toolName: "read", input: { path: "/a" }, rawInput: '{"path":"/a"}' }, originalIndex: 3 },
  ];
  const { total, cache } = estimateStreamedTokens(items, new Map());
  assert.equal(cache.size, 3);
  assert.ok(total > 0);
  assert.equal(cache.get(2).text, "想");
  const next = estimateStreamedTokens([items[0]], cache);
  assert.equal(next.total, cache.get(0).tokens);
});

test("renders a complete SDK skill expansion as a compact command", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION,
  });

  assert.match(html, /#review/);
  assert.match(html, /src\/main\.ts/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Review the supplied files/);
});

test("does not collapse incomplete skill-looking user text", () => {
  const html = renderMessage({
    role: "user",
    content: '<skill name="review" location="/skills/review/SKILL.md">\nordinary user text',
  });

  assert.match(html, /ordinary user text/);
  assert.doesNotMatch(html, /aria-expanded/);
});

test("shows every line of pasted plain text in a user message (#680)", () => {
  const lines = [
    "第1题（看门狗）",
    "嵌入式系统中，看门狗（WatchDog）的基本工作原理是（ ）",
    "A. 监控系统温度，过热时自动降频",
    "B. 计数器自动计数，程序定期将其重置；若程序跑飞计数器溢出，则系统复位重启",
  ];
  const expected = `<p>${lines.join("<br/>")}</p>`;

  for (const lineEnding of ["\n", "\r\n", "\r"]) {
    const html = renderMessage({ role: "user", content: lines.join(lineEnding) });
    assert.ok(html.includes(expected), JSON.stringify(lineEnding));
    assert.doesNotMatch(html, /\r/);
  }

  const listHtml = renderMessage({
    role: "user",
    content: [{ type: "text", text: "1. 看门狗的原理是（ ）\nA. 监控温度\nB. 计数器" }],
  });
  assert.match(listHtml, /<li>看门狗的原理是（ ）<br\/>A\. 监控温度<br\/>B\. 计数器<\/li>/);
});

test("keeps assistant soft line breaks as Markdown paragraphs", () => {
  const html = renderMessage({ role: "assistant", content: [{ type: "text", text: "one\ntwo" }] });

  assert.match(html, /<p>one\ntwo<\/p>/);
  assert.doesNotMatch(html, /<br/);
});

test("renders lone carriage returns in compact command arguments as line breaks", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION.replace("src/main.ts", "src/main.ts\rsrc/app.ts"),
  });

  assert.match(html, /#review/);
  assert.match(html, /src\/main\.ts\nsrc\/app\.ts/);
  assert.doesNotMatch(html, /\r/);
});

test("keeps attached images when restoring a compact command for editing", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const restored = replaceUserMessageText({
    role: "user",
    content: [{ type: "text", text: COMPLETE_SKILL_EXPANSION }, image],
  }, "/skill:review src/main.ts");

  assert.deepEqual(restored.content, [
    { type: "text", text: "/skill:review src/main.ts" },
    image,
  ]);
});

test("renders user-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("marks apply_patch returned failures as errors even when isError is unset", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-patch-1",
    toolName: "apply_patch",
    input: {
      input: "*** Begin Patch\n*** Update File: src/a.ts\n-old\n+new\n*** End Patch",
    },
  };
  const failed = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "apply_patch failed.\nRecovery: MUST read src/a.ts before retrying." }],
    details: {
      result: { appliedFiles: [], failures: [{ filePath: "src/a.ts", message: "context mismatch" }] },
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [block],
  }, { toolResults: new Map([[block.toolCallId, failed]]) });

  assert.match(html, /class="tool-call-card is-error"/);
  // §2.8: apply_patch rides the edit family's localized kind word.
  assert.match(html, />Edit</);
  assert.doesNotMatch(html, /class="tool-call-card"/);
});

test("collapses a displayed custom message from its header alone", () => {
  const custom = (props) => renderMessage({
    role: "custom",
    customType: "extension",
    display: true,
    timestamp: Date.now(),
    ...props,
  });
  // The header is the card's first button and the only one holding the title.
  const header = (html) => html.slice(0, html.indexOf("</button>"));

  // The header is the toggle, so a message with no `details` can collapse too.
  const shown = custom({ content: [{ type: "text", text: "a message with no details" }] });
  assert.match(header(shown), /aria-expanded="true"/);
  assert.match(header(shown), />extension</);
  // The footer is for details only; it is not a second way to collapse.
  assert.doesNotMatch(shown, /Show details|Hide details/);

  // It starts expanded, as pi's TUI draws a displayed custom message in full.
  assert.match(shown, /a message with no details/);
  // A message with no text (images only) can collapse too.
  assert.match(header(custom({ content: [] })), /aria-expanded="true"/);

  // A message that does carry details keeps that button, for its details.
  assert.match(
    custom({ content: [{ type: "text", text: "a message with details" }], details: { files: ["a.ts"] } }),
    /Show details/,
  );
});

test("renders custom-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "custom",
    customType: "extension",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("tool-result images live inside the fold, not pinned before it", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-shot-1",
    toolName: "page_screenshot",
    input: { tabId: 7 },
  };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [
      { type: "text", text: "captured-1280x720" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
  };
  const message = {
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  };
  const collapsed = renderMessage(message, { toolResults: new Map([[block.toolCallId, result]]) });
  // Collapsed: the row is the summary alone — image, text and args all stay hidden.
  assert.doesNotMatch(collapsed, /<img/);
  assert.doesNotMatch(collapsed, /captured-1280x720/);
  assert.doesNotMatch(collapsed, /"tabId"/);

  setToolCallExpanded(block.toolCallId, true);
  try {
    const expanded = renderMessage(message, { toolResults: new Map([[block.toolCallId, result]]) });
    assert.match(expanded, /<button[^>]+aria-label="Preview image"[^>]*>/);
    assert.match(expanded, /<img[^>]+src="data:image\/png;base64,YWJj"/);
  } finally {
    setToolCallExpanded(block.toolCallId, false);
  }
});

test("uses the unanswered truncation notice for an empty length reply", () => {
  // A nearly full context can clamp the output so far that nothing, not even
  // thinking, comes back; the notice must not blame thinking alone.
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [],
    stopReason: "length",
  });

  assert.match(html, /output limit was reached before an answer/i);
  assert.match(html, /nearly full context/i);
  assert.doesNotMatch(html, /follow-up/i);
});

function textOf(html) {
  return html.replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
}

function codemodeCall(toolCallId, code) {
  return { type: "toolCall", toolCallId, toolName: "codemode", input: { code } };
}

function renderCodemode(block, result) {
  return renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { toolResults: new Map(result ? [[block.toolCallId, result]] : []) });
}

const CODEMODE_SCRIPT = "// @options: {\"timeoutMs\": 5000}\nconst files = await tools.ls({ path: \".\" });\nreturn files.length;";

test("collapses a codemode call to its first script line and call count", (t) => {
  const block = codemodeCall("call-codemode-collapsed", CODEMODE_SCRIPT);
  t.after(() => setToolCallExpanded(block.toolCallId, false));
  const html = renderCodemode(block, {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { type: "text", text: "3" }],
    details: {
      calls: [
        { id: "call-codemode-collapsed/1", name: "ls", args: "{\"path\":\".\"}", status: "ok", durationMs: 4 },
        { id: "call-codemode-collapsed/2", name: "read", args: "{\"path\":\"a\"}", status: "ok", durationMs: 2 },
      ],
    },
  });
  const text = textOf(html);
  assert.match(text, /codemode/);
  assert.match(text, /const files = await tools\.ls\(\{ path: "\." \}\);/);
  assert.match(text, /2 calls/);
  assert.doesNotMatch(text, /@options/);
  assert.doesNotMatch(text, /"code"/);
  assert.doesNotMatch(text, /Tool calls/);
});

test("expands a codemode call into its script, its calls, and the output without the header", (t) => {
  const block = codemodeCall("call-codemode-expanded", CODEMODE_SCRIPT);
  setToolCallExpanded(block.toolCallId, true);
  t.after(() => setToolCallExpanded(block.toolCallId, false));
  const calls = Array.from({ length: 23 }, (_, index) => ({
    id: `call-codemode-expanded/${index + 1}`,
    name: index === 22 ? "bash" : "read",
    args: `{"path":"file-${index + 1}"}`,
    status: index === 22 ? "error" : "ok",
    durationMs: 1500,
    ...(index === 22 ? { error: "exit code 2" } : {}),
  }));
  calls.push(
    { id: "call-codemode-expanded/24", name: "models.classify", args: "", status: "ok", cost: 0.004 },
    { id: "call-codemode-expanded/25", name: "models.classify", args: "", status: "ok", cost: 0.006 },
  );
  const html = renderCodemode(block, {
    role: "toolResult",
    toolCallId: block.toolCallId,
    isError: true,
    content: [
      { type: "text", text: "Script failed\nWall time 4.2 seconds\nOutput:\n" },
      { type: "text", text: "Script error:\nError: exit code 2" },
    ],
    details: { calls },
  });
  const text = textOf(html);

  // The script sits in the plain box any tool's input uses, not a highlighted code block.
  assert.doesNotMatch(html, /markdown-code-block/);
  assert.equal(textOf(html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)[1]), CODEMODE_SCRIPT);
  assert.match(text, /Tool calls/);
  assert.match(text, /Show 5 earlier calls/);
  // The newest 20 of 25 calls are listed; the 5 oldest are folded.
  assert.doesNotMatch(text, /"file-5"/);
  assert.match(text, /"file-6"/);
  assert.match(text, /bash\{"path":"file-23"\}1\.5s/);
  assert.match(text, /exit code 2/);
  assert.match(html, /aria-label="Failed"/);
  assert.match(text, /Model calls: \$0\.01/);
  assert.match(text, /Script error:\nError: exit code 2/);
  assert.doesNotMatch(text, /Wall time/);
  assert.doesNotMatch(text, /"code":/);
});

test("shows a running script's calls without an empty output", (t) => {
  const block = codemodeCall("call-codemode-running", "await tools.read({ path: \"a\" })");
  setToolCallExpanded(block.toolCallId, true);
  t.after(() => setToolCallExpanded(block.toolCallId, false));
  const html = renderCodemode(block, {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [],
    details: {
      calls: [{ id: "call-codemode-running/201", name: "read", args: "{\"path\":\"a\"}", status: "running" }],
      omittedCalls: 200,
    },
  });
  const text = textOf(html);
  assert.match(text, /201 calls/);
  assert.match(text, /200 earlier calls not shown/);
  assert.match(html, /aria-label="Running"/);
  assert.doesNotMatch(text, /No output/i);
});

test("a codemode call with no script or streaming input falls back to a plain body", (t) => {
  const streaming = { ...codemodeCall("call-codemode-streaming", ""), input: {}, rawInput: "{\"code\":\"const secret" };
  setToolCallExpanded(streaming.toolCallId, true);
  t.after(() => setToolCallExpanded(streaming.toolCallId, false));
  const streamingText = textOf(renderCodemode(streaming));
  assert.match(streamingText, /Generating parameters/);
  // The script so far, through the partial parse, rather than its JSON.
  assert.match(streamingText, /codeconst secret/);
  assert.doesNotMatch(streamingText, /\{"code"/);
  assert.doesNotMatch(streamingText, /Tool calls/);

  const other = { type: "toolCall", toolCallId: "call-codemode-other", toolName: "codemode", input: { script: "x" } };
  setToolCallExpanded(other.toolCallId, true);
  t.after(() => setToolCallExpanded(other.toolCallId, false));
  // An argument this view does not understand is still an argument: no script box,
  // but the flat row shows it.
  const otherHtml = renderCodemode(other);
  assert.match(otherHtml, /<table/);
  assert.match(otherHtml, />x<\/td>/);
  assert.doesNotMatch(textOf(otherHtml), /"script": "x"/);
});

test("labels an MCP call server/tool and indents a JSON result", (t) => {
  const block = {
    type: "toolCall",
    toolCallId: "call-mcp-1",
    toolName: "mcp__docs_v2__search",
    input: { query: "codemode" },
  };
  setToolCallExpanded(block.toolCallId, true);
  t.after(() => setToolCallExpanded(block.toolCallId, false));
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, {
    toolResults: new Map([[block.toolCallId, {
      role: "toolResult",
      toolCallId: block.toolCallId,
      content: [{ type: "text", text: "{\"hits\":[{\"title\":\"Code mode\"}]}" }],
      details: { server: "docs.v2", tool: "search" },
    }]]),
  });
  const text = textOf(html);
  assert.match(text, /docs\.v2\/search/);
  assert.match(html, /title="mcp__docs_v2__search"/);
  assert.match(text, /\{\n {2}"hits": \[\n {4}\{\n {6}"title": "Code mode"/);
});

test("keeps the registered name where no result names the server and tool", (t) => {
  // Sanitizing maps docs.v2/search.pages and docs_v2/search_pages to one name, so it is not split.
  const block = { type: "toolCall", toolCallId: "call-mcp-running", toolName: "mcp__docs_v2__search_pages", input: {} };
  const running = textOf(renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { toolResults: new Map() }));
  assert.match(running, /mcp__docs_v2__search_pages/);
  assert.doesNotMatch(running, /docs_v2\//);

  // A codemode script's calls carry only that name, which is also what the script calls.
  const script = codemodeCall("call-codemode-mcp", "await tools.mcp__docs_v2__search_pages({})");
  setToolCallExpanded(script.toolCallId, true);
  t.after(() => setToolCallExpanded(script.toolCallId, false));
  const html = renderCodemode(script, {
    role: "toolResult",
    toolCallId: script.toolCallId,
    content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
    details: { calls: [{ id: "call-codemode-mcp/1", name: "mcp__docs_v2__search_pages", args: "{}", status: "ok" }] },
  });
  assert.match(textOf(html), /mcp__docs_v2__search_pages\{\}/);
});

test("collapses the compaction summary to its title and token count, as pi's TUI does (#1026)", () => {
  const summary = "## Goal\n\nShip the parser fix.\n\n<read-files>\nlib/read.ts\n</read-files>\n\n<modified-files>\nlib/changed.ts\n</modified-files>";
  const message = {
    role: "custom",
    customType: "compaction",
    content: summary,
    display: true,
    details: { tokensBefore: 123456, firstKeptEntryId: "kept0001" },
  };
  const html = renderMessage(message);

  assert.match(html, /<button type="button" aria-expanded="false" title="Expand"/);
  assert.match(html, /Conversation compacted/);
  assert.ok(html.includes(`Compacted from ${(123456).toLocaleString()} tokens`));
  assert.doesNotMatch(html, /Ship the parser fix|following summary|File context|lib\/read\.ts|lib\/changed\.ts/);
  assert.doesNotMatch(renderMessage({ ...message, details: undefined }), /Compacted from/);

  // What the toggle reveals.
  const details = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(CompactionSummaryDetails, { summary }),
  ));
  assert.match(details, /following summary/);
  assert.match(details, /Ship the parser fix/);
  assert.match(details, /File context: 1 read, 1 modified/);
  assert.match(details, /lib\/read\.ts/);
  assert.match(details, /lib\/changed\.ts/);
});

// ── A tool card's patch: two columns where there is room, one where there is not ──

const EDIT_PATCH = `--- a/src/demo.ts
+++ b/src/demo.ts
@@ -10,3 +10,3 @@
 const keep = true;
-const value = "old";
+const value = "new";
done();
`;

const TWO_COLUMN_GRID = "grid-template-columns:minmax(0, 1fr) minmax(0, 1fr)";

function renderPatchFiles(files, layout) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(PatchDiffFiles, { files, layout })),
  );
}

function countIn(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// pi-hashline-edit-pro's insert/replace address lines by anchor and name no file (#1460).
test("a call that names no file is labelled with the one file its result's patch changed", () => {
  const block = { type: "toolCall", toolCallId: "call-insert-path", toolName: "insert", input: { anchor: "kqzmv", direction: "after", text: "x" } };
  const resultWith = (patch) => ({
    role: "toolResult",
    toolCallId: block.toolCallId,
    toolName: "insert",
    content: [{ type: "text", text: "Successfully inserted in src/demo.ts." }],
    details: { patch },
  });
  const render = (result) => renderMessage(
    { role: "assistant", provider: "anthropic", model: "claude-test", content: [block] },
    { toolResults: result ? new Map([[block.toolCallId, result]]) : new Map() },
  );

  const html = render(resultWith(EDIT_PATCH.replace("--- a/", "--- ").replace("+++ b/", "+++ ")));
  assert.match(html, />src\/demo\.ts</);
  assert.doesNotMatch(html, />kqzmv</);

  // No result yet, or a patch over two files: the first argument, as before.
  assert.match(render(undefined), />kqzmv</);
  const onePatch = (file) => `--- ${file}\n+++ ${file}\n@@ -1,1 +1,1 @@\n-old\n+new\n`;
  const twoFiles = onePatch("src/demo.ts") + onePatch("src/other.ts");
  assert.match(render(resultWith(twoFiles)), />kqzmv</);
});

test("a call's own path stays its label over its result's patch", () => {
  const block = { type: "toolCall", toolCallId: "call-edit-own-path", toolName: "edit", input: { path: "src/given.ts" } };
  const result = { role: "toolResult", toolCallId: block.toolCallId, toolName: "edit", content: [{ type: "text", text: "ok" }], details: { patch: EDIT_PATCH } };
  const html = renderMessage(
    { role: "assistant", provider: "anthropic", model: "claude-test", content: [block] },
    { toolResults: new Map([[block.toolCallId, result]]) },
  );
  // R31: file tools render the structured chip, so the call's own path
  // still wins over the result's patch — as chip leaf + directory.
  assert.match(html, /class="tool-file-name">given\.ts</);
  assert.match(html, /class="tool-file-dir">src\//);
  assert.doesNotMatch(html, /class="tool-file-name">demo\.ts</);
});

test("an edit card draws the applied patch in two columns while there is room", () => {
  const block = { type: "toolCall", toolCallId: "call-edit-columns", toolName: "edit", input: { path: "src/demo.ts" } };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    toolName: "edit",
    content: [{ type: "text", text: "ok" }],
    details: { patch: EDIT_PATCH },
  };
  setToolCallExpanded(block.toolCallId, true);
  try {
    const html = renderMessage(
      { role: "assistant", provider: "anthropic", model: "claude-test", content: [block] },
      { toolResults: new Map([[block.toolCallId, result]]) },
    );
    assert.ok(html.includes(TWO_COLUMN_GRID), "the card reaches the patch view");
    assert.ok(html.includes("const value = &quot;new&quot;;"));
  } finally {
    clearExpandedToolCalls();
  }
});

test("the same patch in one column: no line twice, the removed line above what replaces it", () => {
  const stacked = renderPatchFiles(parseUnifiedPatch(EDIT_PATCH), "stacked");

  assert.ok(!stacked.includes("grid-template-columns"), "nothing stands beside anything");
  assert.equal(countIn(stacked, "const keep = true;"), 1);
  assert.equal(countIn(stacked, "const value = &quot;old&quot;;"), 1);
  assert.equal(countIn(stacked, "const value = &quot;new&quot;;"), 1);
  assert.ok(stacked.indexOf("&quot;old&quot;;") < stacked.indexOf("&quot;new&quot;;"));

  // The two columns pay for themselves by printing every context line twice.
  const split = renderPatchFiles(parseUnifiedPatch(EDIT_PATCH), "split");
  assert.ok(split.includes(TWO_COLUMN_GRID));
  assert.equal(countIn(split, "const keep = true;"), 2);
});

test("one column names a file section by the file's own path, not by Before and After", () => {
  const files = parseUnifiedPatch(`--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-a
+b
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-c
+d
`);
  const html = renderPatchFiles(files, "stacked");

  assert.ok(html.includes("b/one.ts"), "the first file names its section");
  assert.ok(html.includes("b/two.ts"), "the second file names its section");
  assert.ok(!html.includes(">Before<") && !html.includes(">After<"), "two labels over one column read as two columns");
});

test("the layout is the viewport's choice, taken once for both the patch input and the patch result", () => {
  const source = readFileSync(new URL("./MessageView.tsx", import.meta.url), "utf8");

  // Both the applied-patch card and a result's patch render through SplitFilesView,
  // so a phone never gets one of each.
  assert.match(source, /const layout: PatchDiffLayout = useIsMobile\(\) \? "stacked" : "split";/);
  assert.equal(countIn(source, "<SplitFilesView"), 2);
});

test("§2.8 kind vocabulary: deletes get their own word, never a folded-in Edit (M-minor)", async () => {
  const { toolKindMessageIds } = await jiti.import("./MessageView.tsx");
  assert.deepEqual(toolKindMessageIds("delete"), {
    running: "chat.toolCall.edit.deleting",
    done: "chat.toolCall.kind.delete",
  });
  // Decorated delete names win over the broader edit match.
  assert.equal(toolKindMessageIds("fs_delete")?.done, "chat.toolCall.kind.delete");
  assert.equal(toolKindMessageIds("edit")?.done, "chat.toolCall.kind.edit");
});

test("edit diffs carry their own frame flush to the tool-content edges, never the execute panel (M-finding-4)", () => {
  const source = readFileSync(new URL("./MessageView.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/conversation.css", import.meta.url), "utf8");

  // ZCode's EditInlineDiffContent frame: rounded-xl border bg-card, and the
  // multi-file rail (edit.tsx:216's ml-2 border-l pl-3.5).
  assert.match(source, /<div className="tool-diff-frame">/);
  assert.match(source, /patchFiles\.length > 1 \? "tool-diff-rail" : undefined/);
  // The padded execute surface no longer wraps the diff views; it survives only
  // for execute-style content (the result-text pairing).
  assert.doesNotMatch(source, /tool-detail-surface">\s*\{patchFiles &&/);
  assert.match(css, /\.tool-diff-frame \{[^}]*border-radius: var\(--radius-xl\);[^}]*background: var\(--card\);/s);
  assert.match(css, /\.tool-diff-rail \{[^}]*margin-left: 8px;[^}]*border-left: 1px solid var\(--border\);[^}]*padding-left: 14px;/s);
});

test("one column numbers a removed line by the old file and every other line by the new one", () => {
  const stacked = renderPatchFiles(parseUnifiedPatch(`--- a/src/demo.ts
+++ b/src/demo.ts
@@ -10,3 +10,4 @@
 const keep = true;
-const value = "old";
+const value = "new";
+const extra = 1;
 done();
@@ -30,1 +31,1 @@
-late
+LATE
`), "stacked");

  const gutter = [...stacked.matchAll(/width:42px[^>]*>(\d*)</g)].map((match) => match[1]);
  // done() is old line 12 but new line 13: the new file's number, as in the file viewer's gutter.
  assert.deepEqual(gutter, ["10", "11", "11", "12", "13", "30", "31"]);
  // The lines between the hunks stay marked, as in the two-column view.
  assert.equal(countIn(stacked, "⋯ 17 unchanged lines"), 1);
});

test("one column names a deleted file's section by its old path", () => {
  const html = renderPatchFiles(parseUnifiedPatch(`--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
--- a/kept.ts
+++ b/kept.ts
@@ -1 +1 @@
-a
+b
`), "stacked");

  assert.ok(html.includes(">a/gone.ts<"));
  assert.ok(!html.includes("/dev/null"));
});

// ── Wave L: the row is §2 verbatim — counts, neutral ink, tooltip errors ──

test("an edit result's patch rides the row as +N/-N mono counts (§2.1)", () => {
  const block = { type: "toolCall", toolCallId: "call-diffcount", toolName: "edit", input: { path: "src/demo.ts" } };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    toolName: "edit",
    content: [{ type: "text", text: "ok" }],
    details: { patch: EDIT_PATCH },
  };
  const html = renderMessage(
    { role: "assistant", provider: "anthropic", model: "claude-test", content: [block] },
    { toolResults: new Map([[block.toolCallId, result]]) },
  );
  assert.match(html, /tool-diffcount-added">\+1</);
  assert.match(html, /tool-diffcount-removed">-1</);
});

test("a failed call keeps neutral row ink; the error is the status word's tooltip (§2.4)", () => {
  const block = { type: "toolCall", toolCallId: "call-failed-1", toolName: "bash", input: { command: "make" } };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    toolName: "bash",
    content: [{ type: "text", text: "make: *** No rule" }],
    isError: true,
  };
  const html = renderMessage(
    { role: "assistant", provider: "anthropic", model: "claude-test", content: [block] },
    { toolResults: new Map([[block.toolCallId, result]]) },
  );
  // No red/green on the row: the kind label carries no inline color.
  assert.doesNotMatch(html, /class="tool-kind[^"]*" title="[^"]*" style=/);
  assert.match(html, /aria-label="Failed"/);
  assert.match(html, /tool-error-text">make: \*\*\* No rule/);
  assert.match(html, /tool-error-copy/);
});

test("a running codemode script's row sweeps while its finished nested calls do not", () => {
  const block = codemodeCall("call-codemode-sweep", "await tools.read({ path: \"a\" })");
  const html = renderCodemode(block, {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [],
    details: { calls: [{ id: "call-codemode-sweep/1", name: "read", args: "{}", status: "ok" }] },
  });
  assert.match(html, /tool-kind animated-gradient-text">codemode</);
});

// ── Wave M: §2.8 kind vocabulary, §2.1 MCP slots, §4.1 bubble, §4.2 rhythm ──

test("§2.8: generic rows render localized kind words — running vs done (read, terminal, agent)", () => {
  const row = (toolName, result) => {
    const block = { type: "toolCall", toolCallId: `call-kind-${toolName}`, toolName, input: { path: "src/a.ts" } };
    return renderMessage(
      { role: "assistant", provider: "anthropic", model: "claude-test", content: [block] },
      { toolResults: result ? new Map([[block.toolCallId, result]]) : new Map() },
    );
  };
  const done = (toolName) => ({
    role: "toolResult", toolCallId: `call-kind-${toolName}`, toolName,
    content: [{ type: "text", text: "ok" }], isError: false,
  });

  // Running vocabulary sweeps; done vocabulary rests in subtle ink.
  assert.match(row("read"), /tool-kind animated-gradient-text">Reading</);
  assert.match(row("read", done("read")), /class="tool-kind">Read</);
  assert.match(row("bash", { role: "toolResult", toolCallId: "call-kind-bash", toolName: "bash", content: [{ type: "text", text: "ok" }] }), />Terminal</);
  assert.match(row("Agent", undefined), /animated-gradient-text">Running</);
  // The raw tool name never shows for a known family.
  assert.doesNotMatch(row("read", done("read")), />read</);

  // A local bash run keeps its qualifier as the quiet sourceLabel chip (§2.1).
  const localName = "bash (local)";
  const local = row(localName, { role: "toolResult", toolCallId: `call-kind-${localName}`, toolName: localName, content: [{ type: "text", text: "ok" }] });
  assert.match(local, />Terminal</);
  assert.match(local, /class="tool-source-label">\(local\)</);
});

test("§2.8: the kind vocabulary is registered in all three locales with ZCode's phrasing", async () => {
  const { enLocale } = await jiti.import("@/lib/i18n/messages/en");
  const { zhCNLocale } = await jiti.import("@/lib/i18n/messages/zh-CN");
  const { zhTWLocale } = await jiti.import("@/lib/i18n/messages/zh-TW");
  const rows = [
    [enLocale.messages, { "chat.toolCall.kind.read": "Read", "chat.toolCall.read.reading": "Reading", "chat.toolCall.kind.terminal": "Terminal", "chat.toolCall.kind.agent": "Agent", "chat.toolCall.kind.mcp": "MCP", "chat.reasoning.fewSeconds": "a few seconds" }],
    [zhCNLocale.messages, { "chat.toolCall.kind.read": "读取", "chat.toolCall.read.reading": "读取中", "chat.toolCall.kind.terminal": "终端", "chat.toolCall.kind.agent": "子代理", "chat.toolCall.kind.mcp": "MCP", "chat.reasoning.fewSeconds": "几秒" }],
    [zhTWLocale.messages, { "chat.toolCall.kind.read": "讀取", "chat.toolCall.read.reading": "讀取中", "chat.toolCall.kind.terminal": "終端", "chat.toolCall.kind.agent": "子代理", "chat.toolCall.kind.mcp": "MCP", "chat.reasoning.fewSeconds": "幾秒" }],
  ];
  for (const [messages, expected] of rows) {
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(messages[key], value, `${key}`);
    }
  }
});

test("§2.1: an MCP row reads kind 'MCP' + kindDetail server/tool; an unsplittable name rides kindDetail", () => {
  const named = {
    type: "toolCall", toolCallId: "call-mcp-kind", toolName: "mcp__docs_v2__search", input: {},
  };
  const html = renderMessage(
    { role: "assistant", provider: "anthropic", model: "claude-test", content: [named] },
    { toolResults: new Map([[named.toolCallId, {
      role: "toolResult", toolCallId: named.toolCallId, content: [{ type: "text", text: "ok" }],
      details: { server: "docs.v2", tool: "search" },
    }]]) },
  );
  assert.match(html, /class="tool-kind">MCP</);
  assert.match(html, /class="tool-kind-detail" title="mcp__docs_v2__search">docs\.v2\/search</);

  // No result naming the parts: the registered name is the detail, still no raw prefix split.
  const unnamed = renderMessage(
    { role: "assistant", provider: "anthropic", model: "claude-test", content: [{ ...named, toolCallId: "call-mcp-kind-2", toolName: "mcp__docs_v2__search_pages" }] },
    { toolResults: new Map() },
  );
  // Pending, so the kind word carries the sweep — still "MCP", never a raw split.
  assert.match(unnamed, /class="tool-kind animated-gradient-text">MCP</);
  assert.match(unnamed, /tool-kind-detail[^>]*>mcp__docs_v2__search_pages</);
  assert.doesNotMatch(unnamed, /docs_v2\//);
});

test("§4.1: the user bubble is borderless on --user-bg, radius 12, px-4/py-3, max-w 576", () => {
  const html = renderMessage({ role: "user", content: [{ type: "text", text: "hello there" }] });
  assert.match(html, /data-user-message-bubble/);
  assert.match(html, /background:var\(--user-bg\)/);
  assert.match(html, /border:none/);
  assert.match(html, /border-radius:12px/);
  assert.match(html, /padding:12px 16px/);
  assert.match(html, /font-size:var\(--conversation-font-size, 16px\)/);
  assert.match(html, /max-width:min\(576px, 100%\)/);
  // The stream rhythm: the turn gap is 20px (§4.2 gap-5).
  assert.match(html, /margin-bottom:20px/);
});

test("§4.2: assistant blocks ride the 16px tool-group rhythm inside the 20px turn", () => {
  const html = renderMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hm" },
      { type: "text", text: "answer" },
    ],
  });
  assert.match(html, /style="display:flex;flex-direction:column;gap:16px"/);
  assert.match(html, /data-message-role="assistant" style="margin-bottom:20px"/);
});

test("§3: a finished thinking block with no duration reads 'Thought · a few seconds'", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ThinkingBlock, {
      block: { type: "thinking", thinking: "short thought" },
      blockIndex: 0,
    }),
  ));
  assert.match(html, />Thought</);
  assert.match(html, / · a few seconds</);
});

test("§2.1: the row's summary rolls behind the separator dot", () => {
  const block = { type: "toolCall", toolCallId: "call-roll-1", toolName: "bash", input: { command: "ls -la" } };
  const html = renderMessage(
    { role: "assistant", provider: "anthropic", model: "claude-test", content: [block] },
    { toolResults: new Map() },
  );
  assert.match(html, /class="tool-separator">·</);
  assert.match(html, /tool-summary-roll tool-summary-text/);
  assert.match(html, /tool-summary-roll-item">ls -la</);
});

test("§2.1: read/write rows show ZCode's structured file chip, not a path string", () => {
  const block = { type: "toolCall", toolCallId: "call-chip-1", toolName: "read", input: { path: "apps/web/components/ChatWindow.tsx" } };
  const html = renderMessage(
    { role: "assistant", provider: "anthropic", model: "claude-test", content: [block] },
    { toolResults: new Map() },
  );
  assert.match(html, /class="tool-file-chip"/);
  assert.match(html, /class="tool-file-name">ChatWindow\.tsx</);
  assert.match(html, /class="tool-file-dir">apps\/web\/components\//);
  assert.doesNotMatch(html, /tool-summary-roll tool-summary-text/);
});
test("R23a: an assistant message carries no per-message model label", () => {
  const html = renderMessage(
    { role: "assistant", provider: "anthropic", model: "claude-test", content: [{ type: "text", text: "Done." }], stopReason: "stop" },
    { modelNames: { "anthropic:claude-test": "Claude Test" } },
  );
  assert.doesNotMatch(html, /Claude Test/);
  // The content starts the message: the first block wrapper, no label row.
  assert.match(html, /data-message-role="assistant"[^>]*><div style="display:flex;flex-direction:column;gap:16px"/);
});

test("R23b: the assistant actions row is hover-only and owns the time and usage", () => {
  const timestamp = Date.now();
  const time = new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const html = renderMessage({
    role: "assistant", provider: "anthropic", model: "claude-test", content: [{ type: "text", text: "Done." }], stopReason: "stop",
    usage: { input: 1_234, output: 567, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    timestamp,
  }, { showTimestamp: true });
  // Nothing stands until the row is hovered (ZCode opacity-0 → hover).
  assert.match(html, /class="message-actions-row is-hidden"/);
  assert.match(html, /class="message-action"/);
  assert.match(html, /aria-label="Copy message"/);
  assert.match(html, new RegExp(`>${time}<`));
  assert.match(html, />1\.2k</);
  // The time and the counts live inside the row, not above it.
  const rowStart = html.indexOf("message-actions-row");
  assert.ok(html.indexOf(`>${time}<`) > rowStart);
  assert.ok(html.indexOf("1.2k") > rowStart);
  // ZCode's MessageActions order: copy, then the usage counts, time last.
  assert.ok(html.indexOf("aria-label=\"Copy message\"") < html.indexOf("1.2k"), "copy before stats");
  assert.ok(html.indexOf("1.2k") < html.indexOf(`>${time}<`), "stats before time");
});

test("R23b: a process-fold segment renders no actions row at all (showActions=false)", () => {
  const timestamp = Date.now();
  const html = renderMessage({
    role: "assistant", provider: "anthropic", model: "claude-test", content: [{ type: "text", text: "Intermediate." }], stopReason: "stop",
    usage: { input: 1_234, output: 567, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    timestamp,
  }, { showTimestamp: true, showActions: false });
  assert.doesNotMatch(html, /message-actions-row/);
  assert.doesNotMatch(html, /Copy message/);
  // The text still renders; only the row is gone.
  assert.match(html, /Intermediate\./);
});

test("R23b: the user bubble has no standing timestamp and keeps the injected epilogue inside it", () => {
  const timestamp = Date.now();
  const time = new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const html = renderMessage({
    role: "user",
    timestamp,
    content: [{ type: "text", text: "hello there\n\n<message_time>\n2026-01-02\n</message_time>" }],
  }, { onOpenInjectedContext: () => {} });
  // No standing time row anywhere on a user message.
  assert.ok(!html.includes(`>${time}<`), time);
  // R26/R27: injected context is NOT in the bubble — per-producer chips ride
  // the hover actions row below it, and no inline <details> exists anywhere.
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /class="injected-context-chip" data-producer="runtime-context"/);
  assert.match(html, /injected-context-chip[^>]*><svg[\s\S]*?<\/button><button[^>]*class="message-action"/);
});

test("R27: injected-context chips are per-producer, hover-row only, callback-gated", () => {
  const message = {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: "hello there\n\n<message_time>\n2026-01-02\n</message_time>" }],
  };
  const html = renderMessage(message, { onOpenInjectedContext: () => {} });
  // One chip per injected producer, inside the actions row (never the bubble).
  assert.equal((html.match(/injected-context-chip" data-producer/g) ?? []).length, 1);
  assert.match(html, /message-actions-row[\s\S]*?injected-context-chip/);
  // Without the callback no chip renders at all.
  assert.doesNotMatch(renderMessage(message), /injected-context-chip/);
});
