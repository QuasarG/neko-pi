import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// `/share`, `/bug` and `/quit` are answered by the Web client itself: the
// first two open their consent dialogs, /quit explains that a browser has no
// process to quit. None of the three may reach the agent as a prompt.

const read = async (path) => (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const hookSource = await read("./useAgentSession.ts");
const hookFile = ts.createSourceFile("useAgentSession.ts", hookSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function callbackSource(name) {
  let found;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node)
      && node.name.getText(hookFile) === name
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(hookFile) === "useCallback"
    ) {
      found = node.initializer.arguments[0];
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(hookFile);
  assert.ok(found, `useCallback ${name} not found`);
  return ts.transpileModule(`(${found.getText(hookFile)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.trim().replace(/;$/, "");
}

const handleBuiltinSlashCommand = new Function(
  "scope",
  `with (scope) { return ${callbackSource("handleBuiltinSlashCommand")}; }`,
);

function hook() {
  const calls = { notices: [], share: 0, bug: [], agent: [], newSessions: 0 };
  const scope = {
    sessionIdRef: { current: "session-1" },
    // Synced from the session prop every render; null until one is selected.
    sessionPropIdRef: { current: null },
    ensureNewSession: async () => {
      calls.newSessions += 1;
      return "session-1";
    },
    addNotice: (notice) => calls.notices.push(notice),
    translateRef: { current: (key) => key },
    displayModel: { provider: "faux", modelId: "faux-one" },
    onShareCommand: () => { calls.share += 1; },
    onBugCommand: (hint, model) => calls.bug.push({ hint, model }),
    sendAgentCommand: (sid, command) => {
      calls.agent.push(command);
      throw new Error("no agent command may run for these builtins");
    },
  };
  return { run: handleBuiltinSlashCommand(scope), calls, scope };
}

test("/quit is answered client-side and never sent to the model", async () => {
  const { run, calls } = hook();
  assert.deepEqual(await run("/quit"), { handled: true, message: "chat.quitNotice" });
  assert.deepEqual(calls.notices, [{ type: "success", message: "chat.quitNotice" }]);
  assert.deepEqual(calls.agent, []);
});

test("/share opens the consent dialog", async () => {
  const { run, calls } = hook();
  assert.deepEqual(await run("/share"), { handled: true, action: "shareSession" });
  assert.equal(calls.share, 1);
  assert.deepEqual(calls.agent, []);
  assert.deepEqual(calls.notices, [], "the dialog is the answer; no completion notice");
});

test("/bug prefills the dialog with its description argument and the model", async () => {
  const { run, calls } = hook();
  assert.deepEqual(await run("/bug it crashed after saving"), { handled: true, action: "bugReport" });
  assert.deepEqual(calls.bug, [{ hint: "it crashed after saving", model: { provider: "faux", modelId: "faux-one" } }]);
  assert.deepEqual(calls.agent, []);

  const bare = hook();
  assert.deepEqual(await bare.run("/bug"), { handled: true, action: "bugReport" });
  assert.deepEqual(bare.calls.bug, [{ hint: "", model: { provider: "faux", modelId: "faux-one" } }]);
});

test("/share with an argument falls through to the model, as in the TUI", async () => {
  const { run, calls } = hook();
  assert.deepEqual(await run("/share everywhere"), { handled: false });
  assert.equal(calls.share, 0);
});

test("without a wired handler the commands fall through instead of vanishing", async () => {
  const scope = {
    sessionIdRef: { current: "session-1" },
    sessionPropIdRef: { current: null },
    addNotice: () => {},
    translateRef: { current: (key) => key },
    displayModel: null,
    onShareCommand: undefined,
    onBugCommand: undefined,
  };
  const run = handleBuiltinSlashCommand(scope);
  assert.deepEqual(await run("/share"), { handled: false });
  assert.deepEqual(await run("/bug"), { handled: false });
  // /quit needs nothing but the translator; it is always answered.
  assert.deepEqual(await run("/quit"), { handled: true, message: "chat.quitNotice" });
});

// Live repro: the tab mounts with no session, a sidebar click selects one
// without remounting ChatWindow, and the mount-only sessionIdRef stays null
// while the session is visibly active. The gates must use the prop-synced id.
test("sessionless mount then sidebar selection still opens the dialogs (stale sessionIdRef)", async () => {
  const { run, calls, scope } = hook();
  scope.sessionIdRef.current = null;
  scope.sessionPropIdRef.current = "session-1";

  assert.deepEqual(await run("/share"), { handled: true, action: "shareSession" });
  assert.equal(calls.share, 1);
  assert.deepEqual(await run("/bug it broke"), { handled: true, action: "bugReport" });
  assert.deepEqual(calls.bug, [{ hint: "it broke", model: { provider: "faux", modelId: "faux-one" } }]);
  assert.deepEqual(calls.agent, [], "neither command falls through to the model");
  assert.equal(calls.newSessions, 0, "an existing session needs no new one");
});

test("with no session at all the commands still fall through", async () => {
  const bare = hook();
  bare.scope.sessionIdRef.current = null;
  bare.scope.sessionPropIdRef.current = null;
  assert.deepEqual(await bare.run("/share"), { handled: false });
  assert.deepEqual(await bare.run("/bug"), { handled: false });
  assert.equal(bare.calls.share, 0);
  assert.equal(bare.calls.newSessions, 0, "no session is created just to refuse a command");
});
