import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "neko-web-context-"));
const previous = process.env.NEKO_PI_HOME;
process.env.NEKO_PI_HOME = agentDir;
test.after(() => {
  if (previous === undefined) delete process.env.NEKO_PI_HOME;
  else process.env.NEKO_PI_HOME = previous;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { MessageView } = await jiti.import("../components/MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { catalogFirstMessage, buildSessionContext } = await jiti.import("./session-reader.ts");

const human = "Inspect the current project";
const delivered = `${human}\n\n<message_time>\n2026-10-30\n</message_time>\n\n<runtime_memory>\n### Memory baseline: persona\n- record: preferences\n- version: 2\n- file: /private/preferences.md\n<script>untrusted</script>\n</runtime_memory>\n\n<checkpoint>\ncontinuity\n</checkpoint>`;

function render(content) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(MessageView, { message: { role: "user", content } })));
}

test("user bubbles separate harness context by producer without rewriting the transcript", () => {
  const entry = { type: "message", id: "user-1", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "user", content: delivered } };
  const context = buildSessionContext([entry], entry.id);
  assert.equal(context.messages[0].content, delivered);
  const html = render(context.messages[0].content);
  const bubble = html.slice(0, html.indexOf("data-injected-context"));
  assert.match(bubble, /Inspect the current project/);
  assert.doesNotMatch(bubble, /private\/preferences|message_time|runtime_memory|checkpoint/);
  assert.match(html, /Context · runtime-context/);
  assert.match(html, /Context · memory/);
  assert.match(html, /baseline persona 1本/);
  assert.match(html, /private\/preferences\.md/);
  assert.match(html, /&lt;script&gt;untrusted&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal((html.match(/<details/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
});

test("a message ending in a harness error tag leaves the bubble clean and the block captured", () => {
  const html = render("帮我看看\n\n<wardrobe_error>\nThe wardrobe configuration is invalid (parse failed). Outfits are unavailable.\n</wardrobe_error>");
  assert.match(html, /data-injected-context/);
  const bubble = html.slice(0, html.indexOf("data-injected-context"));
  assert.match(bubble, /帮我看看/);
  assert.doesNotMatch(bubble, /wardrobe_error|Outfits are unavailable/);
  assert.match(html, /Context · runtime-context/);
  assert.match(html, /wardrobe_error/);
  assert.match(html, /Outfits are unavailable/);
  assert.equal((html.match(/<details/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
});

test("catalogue titles contain only user text and retain the existing title bound", () => {
  assert.equal(catalogFirstMessage(delivered), human);
  assert.equal(catalogFirstMessage(delivered.slice(human.length)), "");
  assert.equal(catalogFirstMessage("x".repeat(800) + "\n\n<checkpoint>\ncontinuity\n</checkpoint>"), "x".repeat(500));
});

test("plain user XML and images retain their existing display", () => {
  assert.doesNotMatch(render("Discuss <runtime_memory> as a tag"), /data-injected-context/);
  const html = render([{ type: "text", text: delivered },
    { type: "image", source: { type: "url", url: "/example.png" } }]);
  assert.match(html, /src="\/example.png"/);
  assert.match(html, /data-injected-context/);
});
