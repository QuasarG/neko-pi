import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { bareMcpOpensSettings } from "../lib/mcp-command.ts";

// A bare /mcp opens Settings › MCP when pi's built-in MCP extension owns it, or
// when the session has no /mcp at all (ADR 0006, lib/mcp-command.ts). These tests
// run the hook's own callbacks, taken from its source, against stubbed state.

const read = async (path) => (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const hookSource = await read("./useAgentSession.ts");
const hookFile = ts.createSourceFile("useAgentSession.ts", hookSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** The function a `const <name> = useCallback(fn, deps)` declaration wraps, as JavaScript. */
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

const CALLBACKS = ["replaceSlashCommands", "requestSlashCommands", "slashCommandsForMcp", "handleBuiltinSlashCommand"];
const compiled = Object.fromEntries(CALLBACKS.map((name) => [
  name,
  // The callbacks read hook state as free variables; `with` resolves them from the scope.
  new Function("scope", `with (scope) { return ${callbackSource(name)}; }`),
]));

const builtinMcp = { name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" } };
const otherMcp = { name: "mcp", source: "extension", sourceInfo: { path: "/home/me/.neko_pi/extensions/mcp-adapter.ts", source: "local", scope: "user", origin: "top-level" } };
const deploy = { name: "deploy", source: "extension", sourceInfo: { path: "/project/.neko_pi/extensions/deploy.ts", source: "local", scope: "project", origin: "top-level" } };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function hook({ commands = [], pending = null, getCommands = async () => ({ commands: [] }), openSettings = true, activeLeafId = "leaf-1" } = {}) {
  const calls = { notices: [], opened: [], requests: [], lists: [], errors: [], loading: [], sessionsCreated: 0 };
  const scope = {
    sessionIdRef: { current: "session-1" },
    activeLeafId,
    agentRunningRef: { current: false },
    bashRunningRef: { current: false },
    ensureNewSession: async () => { calls.sessionsCreated += 1; return "session-1"; },
    addNotice: (notice) => calls.notices.push(notice),
    translate: (key) => key,
    onOpenSettings: openSettings ? (section) => calls.opened.push(section) : undefined,
    onBranchesPanelOpen: () => calls.opened.push("branches"),
    onModelCommand: (query) => calls.opened.push(`model:${query}`),
    onThinkingCommand: (query) => calls.opened.push(`thinking:${query}`),
    onNewSessionCommand: () => calls.opened.push("new"),
    onDebugCommand: () => calls.opened.push("debug"),
    onExportCommand: () => calls.opened.push("export"),
    onResumeCommand: () => calls.opened.push("resume"),
    onTrustCommand: () => calls.opened.push("trust"),
    onAuthCommand: (mode, provider) => calls.opened.push(`${mode}:${provider}`),
    onHelpCommand: (kind) => calls.opened.push(kind),
    onSessionStatsPanelOpen: () => calls.opened.push("session"),
    onSessionForked: (id) => calls.opened.push(`forked:${id}`),
    loadSession: async () => ({ info: { name: "fixture" } }),
    loadTools: async () => calls.opened.push("tools-loaded"),
    loadSlashCommands: async () => calls.opened.push("commands-loaded"),
    loadModels: async () => calls.opened.push("models-loaded"),
    promoteNewSession: () => calls.opened.push("promoted"),
    setSessionStatsOverride: () => calls.opened.push("stats-loaded"),
    bareMcpOpensSettings,
    slashCommandsRef: { current: commands },
    slashCommandsLoadRef: { current: pending },
    slashCommandsGenerationRef: { current: 0 },
    setSlashCommands: (list) => calls.lists.push(list),
    setSlashCommandsLoading: (loading) => calls.loading.push(loading),
    sendAgentCommand: async (sid, command) => {
      calls.requests.push(command.type);
      if (command.type === "fork") return { newSessionId: "session-2" };
      if (command.type === "get_session_stats") return { sessionId: sid };
      return getCommands();
    },
    setIsCompacting: () => {},
    console: { error: (...args) => calls.errors.push(args) },
  };
  for (const name of CALLBACKS) scope[name] = compiled[name](scope);
  return { run: scope.handleBuiltinSlashCommand, scope, calls };
}

test("local Settings commands open the existing panel without creating a session", async () => {
  for (const [command, section] of [["/settings", "general"], ["/scoped-models", "models"]]) {
    const { run, calls } = hook();
    assert.deepEqual(await run(command), { handled: true, action: "openSettings" });
    assert.deepEqual(calls.opened, [section]);
    assert.equal(calls.sessionsCreated, 0);
    assert.deepEqual(calls.requests, []);
  }
});

test("/tree opens the existing branch navigator without creating a session", async () => {
  const { run, calls } = hook();
  assert.deepEqual(await run("/tree"), { handled: true, action: "openBranches" });
  assert.deepEqual(calls.opened, ["branches"]);
  assert.equal(calls.sessionsCreated, 0);
  assert.deepEqual(calls.requests, []);
});

test("/model and /thinking forward search terms to the existing selectors", async () => {
  const { run, calls } = hook();
  assert.deepEqual(await run("/model sonnet"), { handled: true, action: "selectModel" });
  assert.deepEqual(await run("/thinking high"), { handled: true, action: "selectThinking" });
  assert.deepEqual(calls.opened, ["model:sonnet", "thinking:high"]);
  assert.deepEqual(calls.requests, []);
});

test("/new, /debug, /export, /fork and /resume use Web equivalents", async () => {
  const { run, calls } = hook();
  assert.deepEqual(await run("/new"), { handled: true, action: "newSession" });
  assert.deepEqual(await run("/debug"), { handled: true, action: "openDebug" });
  assert.deepEqual(await run("/export"), { handled: true, action: "exportSession" });
  assert.deepEqual(await run("/fork"), { handled: true, action: "fork" });
  assert.deepEqual(await run("/resume"), { handled: true, action: "openSessions" });
  assert.deepEqual(calls.opened, ["new", "debug", "export", "forked:session-2", "resume"]);
  assert.deepEqual(calls.requests, ["fork"]);
});

test("/trust opens the existing project trust dialog without creating a session", async () => {
  const { run, calls } = hook();
  assert.deepEqual(await run("/trust"), { handled: true, action: "openTrust" });
  assert.deepEqual(calls.opened, ["trust"]);
  assert.equal(calls.sessionsCreated, 0);
  assert.deepEqual(calls.requests, []);
});

test("/name, /session and /reload use the active native session and Web panels", async () => {
  const { run, calls } = hook();
  assert.deepEqual(await run("/name"), { handled: true, message: "Session name: fixture" });
  assert.deepEqual(await run("/name renamed"), { handled: true, message: "Session renamed to renamed" });
  assert.deepEqual(await run("/session"), { handled: true, action: "openSessionStats" });
  assert.deepEqual(await run("/reload"), { handled: true, message: "Reloaded session resources" });
  assert.deepEqual(calls.requests, ["set_session_name", "get_session_stats", "reload"]);
  assert.deepEqual(calls.opened, ["promoted", "stats-loaded", "session", "tools-loaded", "commands-loaded", "models-loaded"]);
});

test("/login and /logout route provider selection into Models settings", async () => {
  const { run, calls } = hook();
  assert.deepEqual(await run("/login"), { handled: true, action: "openSettings" });
  assert.deepEqual(await run("/logout"), { handled: true, action: "openSettings" });
  assert.deepEqual(await run("/login anthropic"), { handled: true, action: "openSettings" });
  assert.deepEqual(await run("/logout openai"), { handled: true, action: "openSettings" });
  assert.deepEqual(calls.opened, ["login:", "logout:", "login:anthropic", "logout:openai"]);
  assert.equal(calls.sessionsCreated, 0);
  assert.deepEqual(calls.requests, []);
});

test("/changelog and /hotkeys open local help without creating a session", async () => {
  const { run, calls } = hook();
  assert.deepEqual(await run("/changelog"), { handled: true, action: "openChangelog" });
  assert.deepEqual(await run("/hotkeys"), { handled: true, action: "openHotkeys" });
  assert.deepEqual(calls.opened, ["changelog", "hotkeys"]);
  assert.equal(calls.sessionsCreated, 0);
  assert.deepEqual(calls.requests, []);
});

test("a bare /mcp the built-in owns opens Settings › MCP with no notice and no request", async () => {
  const { run, calls } = hook({ commands: [deploy, builtinMcp] });
  assert.deepEqual(await run("/mcp"), { handled: true, action: "openSettings" });
  assert.deepEqual(calls.opened, ["mcp"]);
  // complete() says nothing for a command that opens a panel.
  assert.deepEqual(calls.notices, []);
  assert.deepEqual(calls.requests, []);
});

test("another extension's /mcp is sent as before", async () => {
  const { run, calls } = hook({ commands: [deploy, otherMcp] });
  assert.deepEqual(await run("/mcp"), { handled: false });
  assert.deepEqual(calls.opened, []);
  assert.deepEqual(calls.notices, []);
});

test("with several extensions' mcp:1 / mcp:2, a bare /mcp opens Settings and /mcp:1 is sent", async () => {
  // pi runs neither for a bare /mcp (it looks commands up by exact name), so sending it would
  // hand the model the text "/mcp"; Settings › MCP says which extensions took the name.
  const commands = [{ ...otherMcp, name: "mcp:1" }, { ...otherMcp, name: "mcp:2" }];
  const bare = hook({ commands });
  assert.deepEqual(await bare.run("/mcp"), { handled: true, action: "openSettings" });
  assert.deepEqual(bare.calls.opened, ["mcp"]);
  const numbered = hook({ commands });
  assert.deepEqual(await numbered.run("/mcp:1"), { handled: false });
  assert.deepEqual(numbered.calls.opened, []);
});

test("every /mcp subcommand is sent, without asking whose /mcp it is", async () => {
  for (const message of ["/mcp login docs", "/mcp logout", "/mcp reconnect", "/mcp   login"]) {
    const { run, calls } = hook({ commands: [] });
    assert.deepEqual(await run(message), { handled: false }, message);
    assert.deepEqual(calls.opened, []);
    assert.deepEqual(calls.requests, []);
  }
});

test("a command list still loading is awaited, not guessed", async () => {
  // The palette asks for the list as "/mcp" is typed; Enter often comes first.
  const load = deferred();
  const { run, calls } = hook({ commands: [], pending: load.promise });
  let settled = false;
  const result = run("/mcp").then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(calls.opened, []);
  load.resolve([builtinMcp]);
  assert.deepEqual(await result, { handled: true, action: "openSettings" });
  assert.deepEqual(calls.opened, ["mcp"]);
  assert.deepEqual(calls.requests, [], "the request under way is reused");

  const other = deferred();
  const second = hook({ commands: [], pending: other.promise });
  const sent = second.run("/mcp");
  other.resolve([otherMcp]);
  assert.deepEqual(await sent, { handled: false });

  // A request under way wins over an older list, which a reload may have outdated.
  const fresh = deferred();
  const third = hook({ commands: [otherMcp], pending: fresh.promise });
  const opened = third.run("/mcp");
  fresh.resolve([builtinMcp]);
  assert.deepEqual(await opened, { handled: true, action: "openSettings" });
});

test("with no list yet, /mcp asks for one and keeps it", async () => {
  const { run, scope, calls } = hook({ getCommands: async () => ({ commands: [builtinMcp] }) });
  assert.deepEqual(await run("/mcp"), { handled: true, action: "openSettings" });
  assert.deepEqual(calls.requests, ["get_commands"]);
  // The ref mirrors the state the palette renders.
  assert.deepEqual(scope.slashCommandsRef.current, [builtinMcp]);
  assert.deepEqual(calls.lists, [[builtinMcp]]);
  assert.equal(scope.slashCommandsLoadRef.current, null);

  // A Chat-only session (or MCP turned off) lists no /mcp at all.
  const chatOnly = hook({ getCommands: async () => ({ commands: [] }) });
  assert.deepEqual(await chatOnly.run("/mcp"), { handled: true, action: "openSettings" });
  assert.deepEqual(chatOnly.calls.requests, ["get_commands"]);
});

test("a list that cannot be read sends /mcp as before", async () => {
  const failing = hook({ getCommands: async () => { throw new Error("HTTP 500"); } });
  assert.deepEqual(await failing.run("/mcp"), { handled: false });
  assert.deepEqual(failing.calls.opened, []);
  assert.deepEqual(failing.calls.notices, []);
  assert.equal(failing.calls.errors.length, 1);

  // A failed refresh falls back to the list already loaded.
  const refresh = deferred();
  const known = hook({ commands: [builtinMcp], pending: refresh.promise });
  const result = known.run("/mcp");
  refresh.resolve(null);
  assert.deepEqual(await result, { handled: true, action: "openSettings" });
});

test("an older request answering after a newer one does not overwrite it", async () => {
  const answers = [deferred(), deferred()];
  const { scope, calls } = hook();
  let next = 0;
  scope.sendAgentCommand = async () => answers[next++].promise;
  const older = scope.requestSlashCommands();
  const newer = scope.requestSlashCommands();
  await new Promise((resolve) => setImmediate(resolve));
  answers[1].resolve({ commands: [builtinMcp] });
  await newer;
  assert.deepEqual(scope.slashCommandsRef.current, [builtinMcp]);
  answers[0].resolve({ commands: [otherMcp] });
  await older;
  assert.deepEqual(scope.slashCommandsRef.current, [builtinMcp]);
  assert.deepEqual(calls.lists, [[builtinMcp]]);
  assert.equal(scope.slashCommandsLoadRef.current, null);
});

test("without a way to open Settings, /mcp is sent", async () => {
  const { run, calls } = hook({ commands: [builtinMcp], openSettings: false });
  assert.deepEqual(await run("/mcp"), { handled: false });
  assert.deepEqual(calls.requests, []);
});
