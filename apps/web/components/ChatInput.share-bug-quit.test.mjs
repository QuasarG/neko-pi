import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { canRunBuiltinSlashCommandWhileStreaming, getBuiltinSlashCommand } = await jiti.import("./ChatInput.tsx");

// /share, /bug and /quit must be intercepted by the composer before anything
// is sent: the palette maps them to the Web flows instead of the model.
test("/share, /bug and /quit are builtin commands", () => {
  assert.equal(getBuiltinSlashCommand("/share")?.name, "share");
  assert.equal(getBuiltinSlashCommand("/bug")?.name, "bug");
  assert.equal(getBuiltinSlashCommand("/quit")?.name, "quit");
  // /bug carries its description argument, as the TUI's <description> hint.
  assert.equal(getBuiltinSlashCommand("/bug it crashed after saving")?.name, "bug");
});

test("near-miss names stay untouched", () => {
  assert.equal(getBuiltinSlashCommand("/sharex"), undefined);
  assert.equal(getBuiltinSlashCommand("/bugger"), undefined);
  assert.equal(getBuiltinSlashCommand("/quitter"), undefined);
});

test("none of the three runs while a response streams", () => {
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/share"), false);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/bug note"), false);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/quit"), false);
});
