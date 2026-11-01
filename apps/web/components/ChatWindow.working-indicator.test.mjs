import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const sourceText = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("the working timer formats tabular minutes:seconds.deci", () => {
  const format = (sourceText.match(/export function formatWorkingTimer[\s\S]*?\n\}/) ?? [])[0];
  assert.ok(format, "formatWorkingTimer is exported from ChatWindow");
  // Run the component's actual function body, transpiled from source.
  const body = format.replace(/^export /, "");
  const value = new Script(
    `${ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText}\nformatWorkingTimer;`,
  ).runInNewContext({});
  assert.equal(value(0), "0:00.0");
  assert.equal(value(4_700), "0:04.7");
  assert.equal(value(59_100), "0:59.1");
  assert.equal(value(119_100), "1:59.1");
  assert.equal(value(3_600_000), "60:00.0");
  assert.equal(value(-5), "0:00.0", "negative elapsed clamps to zero");
});

test("the working indicator renders ZCode's ChatLoading anatomy (§4.4)", () => {
  // The pulse-dot + label rows are gone; both working states use the row.
  assert.doesNotMatch(sourceText, /animate-\[pulse_1\.5s_infinite\]/);
  assert.match(sourceText, /<ChatLoadingRow/);
  assert.match(sourceText, /label=\{phaseLabel\(agentPhase, t, isCompacting/);
  assert.match(sourceText, /<ChatLoadingRow slow label=\{t\("chat.runningCommand"\)\}/);
  // 3x3 matrix: nine cells on 110ms orbit steps, center static.
  assert.match(sourceText, /Array\.from\(\{ length: 9 \}, \(_, index\) => index \* 110\)/);
  assert.match(sourceText, /index === 4 \? " is-center" : ""/);
  // The clock only runs while a row is on screen.
  assert.match(sourceText, /const workingClockActive = showAgentWorking \|\| showBashWorking;/);

  const css = readFileSync(new URL("../app/conversation.css", import.meta.url), "utf8");
  // Pixel matrix: 13px grid, 1.3px gaps, 1px-radius cells, 650ms orbit over a
  // static 0.07 center, base 0.15, peak token (0.75 light / 1 dark).
  assert.match(css, /\.chat-loading-pixels \{[^}]*width: 13px; height: 13px; gap: 1\.3px/s);
  assert.match(css, /\.chat-loading-pixel \{[^}]*border-radius: 1px/s);
  assert.match(css, /\.chat-loading-pixel\.is-center \{ opacity: 0\.07; \}/);
  assert.match(css, /animation: chat-loading-pixel-on 650ms ease-in-out infinite/);
  assert.match(css, /\.chat-loading-pixels\.is-slow \.chat-loading-pixel:not\(\.is-center\) \{ animation-duration: 950ms; \}/);
  assert.match(css, /--chat-loading-pixel-peak: 0\.75;/);
  assert.match(css, /html\.dark \.chat-loading \{ --chat-loading-pixel-peak: 1; \}/);
  // Label shimmer: 35/50/65 gradient stops, 200% size, 1.4s sweep, weight 500.
  assert.match(css, /var\(--text-muted\) 35%, var\(--text\) 50%, var\(--text-muted\) 65%/);
  assert.match(css, /animation: chat-loading-shimmer 1\.4s linear infinite/);
  assert.match(css, /font-weight: 500/);
  // Row: inline-flex w-fit, 10px gap (gap-2.5), 900ms fade-in, mono timer.
  assert.match(css, /\.chat-loading \{[^}]*display: inline-flex; width: fit-content; align-items: center; gap: 10px;/s);
  assert.match(css, /animation: chat-loading-in 900ms var\(--motion-ease-stream\) both/);
  assert.match(css, /\.chat-loading-timer \{[^}]*font-family: var\(--font-mono\)[^}]*font-variant-numeric: tabular-nums/s);
  // Reduced motion: orbit, shimmer, fade and spinner all stop.
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)?.at(-1) ?? "";
  assert.match(reduced, /\.chat-loading-pixel:not\(\.is-center\),/);
  assert.match(reduced, /\.chat-loading-label \{ animation: none; \}/);
});
