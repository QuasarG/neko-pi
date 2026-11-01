import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const globalsCss = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const conversationCss = readFileSync(new URL("./conversation.css", import.meta.url), "utf8");

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * A minimal rule walker: flattens top-level rules (inside @media too, which
 * our ladder rules never need, but the reduced-motion ones do) into
 * { prelude, decls }. At-rule blocks recurse into their children; keyframe
 * innards are ignored.
 */
function parseRules(css) {
  let i = 0;
  function parseBlock(prelude) {
    const decls = [];
    const children = [];
    while (i < css.length) {
      let seg = "";
      while (i < css.length && !"{};".includes(css[i])) seg += css[i++];
      const ch = css[i];
      if (ch === "{") {
        i += 1;
        children.push(parseBlock(seg.trim()));
      } else if (ch === "}") {
        i += 1;
        return { prelude, decls, children };
      } else if (ch === ";") {
        i += 1;
        const decl = seg.trim();
        const colon = decl.indexOf(":");
        if (colon > 0) decls.push([decl.slice(0, colon).trim(), decl.slice(colon + 1).trim()]);
      }
    }
    return { prelude, decls, children };
  }
  const root = parseBlock("");
  const rules = [];
  (function walk(node) {
    for (const child of node.children) {
      if (child.prelude.startsWith("@")) {
        walk(child);
        continue;
      }
      if (child.children.length > 0) {
        walk(child);
        continue;
      }
      rules.push(child);
    }
  })(root);
  return rules;
}

const globalsRules = parseRules(stripComments(globalsCss));
const conversationRules = parseRules(stripComments(conversationCss));

/** Cascade-aware: collects every matching declaration in document order and
 *  returns the LAST one — a later static override must be what the pin sees,
 *  not evade it by sitting under an earlier ladder rule. */
function declaration(rules, selector, prop) {
  let found = null;
  for (const rule of rules) {
    // Split the selector list on commas that are not inside :is()/:not().
    const selectors = rule.prelude
      .split(/,(?![^(]*\))/)
      .map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const [p, v] of rule.decls) {
      if (p === prop) found = v;
    }
  }
  return found;
}

/** How many rules declare the property for the selector — the primary sites
 *  must have exactly one, so a sneaky second rule cannot slip in unreviewed. */
function declarationCount(rules, selector, prop) {
  let count = 0;
  for (const rule of rules) {
    const selectors = rule.prelude
      .split(/,(?![^(]*\))/)
      .map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const [p] of rule.decls) {
      if (p === prop) count += 1;
    }
  }
  return count;
}

/** Resolves var() chains (with fallbacks) and px-only calc() to "<n>px". */
function resolveSize(value, vars) {
  let out = value;
  for (let guard = 0; guard < 10; guard += 1) {
    const match = /var\((--[A-Za-z0-9-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/.exec(out);
    if (!match) break;
    const replacement = Object.hasOwn(vars, match[1]) ? vars[match[1]] : (match[2] ?? "").trim();
    out = out.slice(0, match.index) + replacement + out.slice(match.index + match[0].length);
  }
  const calc = /calc\(((?:[^()]|\([^()]*\))*)\)/.exec(out);
  if (calc) {
    const terms = calc[1].match(/[+-]?[^+-]+/g) ?? [];
    let px = 0;
    for (const term of terms) {
      const termMatch = /^\s*([+-]?)\s*([\d.]+)px\s*$/.exec(term);
      assert.ok(termMatch, `unresolvable calc term in "${value}": "${term}"`);
      px += (termMatch[1] === "-" ? -1 : 1) * parseFloat(termMatch[2]);
    }
    out = `${out.slice(0, calc.index)}${Math.round(px * 100) / 100}px${out.slice(calc.index + calc[0].length)}`;
  }
  assert.match(out, /^-?[\d.]+px$/, `size did not resolve to px: "${value}" -> "${out}"`);
  return out;
}

/** The var environment the conversation area sees at a knob value. */
function ladderVars(knobPx) {
  const vars = { "--chat-content-font-size": `${knobPx}px` };
  vars["--conversation-font-size"] = resolveSize("var(--chat-content-font-size, 16px)", vars);
  return vars;
}

const defaultVars = {}; // no knob written: every var() takes its fallback.

test("R21: the markdown body IS the knob — var(--chat-content-font-size), no offset indirection", () => {
  assert.equal(declaration(globalsRules, ".markdown-body", "font-size"), "var(--chat-content-font-size, 16px)");
  // The deleted indirection: the variable is neither defined nor referenced.
  const all = stripComments(globalsCss + conversationCss);
  assert.ok(!all.includes("--chat-font-size-offset"), "--chat-font-size-offset still present");
});

test("R21: .markdown-body == .tool-summary == .tool-kind at knob values 12/14/16/18/24, and 16px at default", () => {
  const conversationFontSize = declaration(conversationRules, ".chat-content", "--conversation-font-size");
  assert.equal(conversationFontSize, "var(--chat-content-font-size, 16px)");

  const markdownBody = declaration(globalsRules, ".markdown-body", "font-size");
  const toolRow = declaration(conversationRules, ".tool-summary", "font-size");
  const toolKind = declaration(conversationRules, ".tool-kind", "font-size");
  assert.ok(toolRow !== null && toolKind !== null, "tool row font-size declarations missing");
  // Primary sites are single-sourced: exactly one declaration each, so a
  // later static override cannot ride under the ladder rule unseen.
  assert.equal(declarationCount(globalsRules, ".markdown-body", "font-size"), 1);
  assert.equal(declarationCount(conversationRules, ".tool-summary", "font-size"), 1);
  assert.equal(declarationCount(conversationRules, ".tool-kind", "font-size"), 1);

  for (const knob of [12, 14, 16, 18, 24]) {
    const vars = ladderVars(knob);
    assert.equal(resolveSize(markdownBody, vars), `${knob}px`, `markdown-body at knob ${knob}`);
    assert.equal(resolveSize(toolRow, vars), `${knob}px`, `.tool-summary at knob ${knob}`);
    assert.equal(resolveSize(toolKind, vars), `${knob}px`, `.tool-kind at knob ${knob}`);
  }

  assert.equal(resolveSize(markdownBody, defaultVars), "16px");
  assert.equal(resolveSize(toolRow, defaultVars), "16px");
  assert.equal(resolveSize(toolKind, defaultVars), "16px");
});

test("R21: secondary sizes are calc() steps off the ladder, no static px text sizes on the conversation rows", () => {
  const meta = declaration(conversationRules, ".chat-content", "--conversation-font-size-meta");
  const caption = declaration(conversationRules, ".chat-content", "--conversation-font-size-caption");
  const vars = ladderVars(18);
  assert.equal(resolveSize(meta, vars), "16px");
  assert.equal(resolveSize(caption, vars), "15px");

  // Headings ride the ladder: h1 = +4px, h2 = +2px, h3-h6 = the knob.
  assert.equal(resolveSize(declaration(conversationRules, ".markdown-body h1", "font-size"), ladderVars(16)), "20px");
  assert.equal(resolveSize(declaration(conversationRules, ".markdown-body h2", "font-size"), ladderVars(16)), "18px");
  assert.equal(resolveSize(declaration(conversationRules, ".markdown-body :is(h3,h4,h5,h6)", "font-size"), defaultVars), "16px");

  // The heading weight ladder (§4.3): h1-h4 semibold, h5 medium, h6 normal.
  assert.equal(declaration(conversationRules, ".markdown-body :is(h1,h2,h3,h4)", "font-weight"), "600");
  assert.equal(declaration(conversationRules, ".markdown-body h5", "font-weight"), "500");
  assert.equal(declaration(conversationRules, ".markdown-body h6", "font-weight"), "400");
});

test("R20 straggler (Wave N): the injected-context headings ride the ladder, no static 13px", () => {
  // M re-review's routed fix: h1 = knob+2, h2 = knob, h3-h6 = the context's own
  // meta size (the injected context body sits one step below the chat body).
  const h1 = declaration(globalsRules, ".injected-context-markdown h1", "font-size");
  const h2 = declaration(globalsRules, ".injected-context-markdown h2", "font-size");
  const h3 = declaration(globalsRules, ".injected-context-markdown h3", "font-size");
  assert.ok(h1 && h2 && h3, "injected-context heading declarations missing");
  assert.equal(resolveSize(h1, ladderVars(16)), "18px");
  assert.equal(resolveSize(h2, ladderVars(16)), "16px");
  assert.equal(resolveSize(h3, ladderVars(18)), "16px");
  assert.ok(!/13px/.test(stripComments(globalsCss).match(/\.injected-context-markdown h1[\s\S]{0,400}?\/\.injected-context-markdown h6 \{[^}]*\}/)?.[0] ?? ""), "static heading px remains");
});

test("§5: the message-level streaming entrance is the 900ms stream-curve fade, gated and cut off under reduced motion", () => {
  // The curve token is ZCode's zcode-stream-text-in easing, verbatim.
  assert.ok(globalsCss.includes("--motion-ease-stream: cubic-bezier(0.16, 1, 0.3, 1)"));
  const conversation = stripComments(conversationCss);
  assert.ok(
    conversation.includes(".transcript-entry-in { animation: pi-stream-text-in 900ms var(--motion-ease-stream) both"),
    "the entry fade must be 900ms on the stream curve",
  );
  // The reduced-motion cutoffs: globals kills the entry fade class itself,
  // conversation kills the new roll keyframes.
  const reducedGlobals = globalsCss.slice(globalsCss.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reducedGlobals, /\.transcript-entry-in,/);
  assert.match(conversation, /\.tool-summary-roll-item\[data-roll="in"\][\s\S]*?animation: none/);
});

test("§2.3/§5: the summary roll keyframes — ±0.8em over 300ms cubic-bezier(0.4,0,0.2,1)", () => {
  const conversation = stripComments(conversationCss);
  assert.ok(conversation.includes("animation: tool-summary-roll-in 300ms cubic-bezier(0.4, 0, 0.2, 1)"));
  assert.ok(conversation.includes("animation: tool-summary-roll-out 300ms cubic-bezier(0.4, 0, 0.2, 1) forwards"));
  assert.ok(conversation.includes("transform: translateY(0.8em)"));
  assert.ok(conversation.includes("transform: translateY(-0.8em)"));
});

test("§5: motion coverage stays tokenized — no `transition: all` anywhere in the conversation sheets", () => {
  const all = stripComments(globalsCss + conversationCss);
  assert.ok(!/transition:\s*all/.test(all), "transition: all found");
});
