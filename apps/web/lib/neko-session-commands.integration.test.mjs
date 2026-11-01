import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { builtInExtensions } from "@earendil-works/pi-coding-agent/extensions";

const root = mkdtempSync(join(tmpdir(), "neko-web-commands-"));
const previous = process.env.NEKO_PI_HOME;
process.env.NEKO_PI_HOME = root;
test.after(() => {
  if (previous === undefined) delete process.env.NEKO_PI_HOME;
  else process.env.NEKO_PI_HOME = previous;
  rmSync(root, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createNekoSessionCommands } = await jiti.import("./neko-session-commands.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

async function setup(t) {
  initTheme();
  const cwd = mkdtempSync(join(root, "project-"));
  const settingsManager = SettingsManager.inMemory();
  const faux = fauxProvider({ models: [{ id: "web-parity" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const first = manager.appendMessage({ role: "user", content: "first request", timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage([fauxText("first reply")]));
  const last = manager.appendMessage({ role: "user", content: "second request\n\n<checkpoint>\ncontinuity\n</checkpoint>", timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage([fauxText("second reply")]));
  let session;
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: root, settingsManager,
    extensionFactories: [createNekoSessionCommands(() => session), ...builtInExtensions.filter((extension) => ["ask-user", "todo", "background-jobs"].includes(extension.name))],
    noExtensions: false, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd, agentDir: root, sessionManager: manager, settingsManager,
    resourceLoader, modelRuntime, model: faux.getModel("web-parity") }));
  const wrapper = new AgentSessionWrapper(session);
  const events = [];
  wrapper.start();
  wrapper.onEvent((event) => events.push(event));
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  t.after(() => wrapper.shutdown());
  return { session, wrapper, manager, first, last, cwd, events, faux };
}

test("/edit uses the native session truncation and refills only human text", async (t) => {
  const { session, manager, last, events } = await setup(t);
  await session.prompt("/edit");
  assert.equal(manager.getEntry(last), undefined);
  const persisted = SessionManager.open(manager.getSessionFile());
  assert.deepEqual(persisted.getEntries(), manager.getEntries());
  assert.equal(persisted.getSessionId(), session.sessionId);
  assert.equal(events.findLast((event) => event.method === "set_editor_text")?.text, "second request");
  assert.equal(persisted.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
});

test("/edit validates its target before changing the session", async (t) => {
  const { session, manager, events } = await setup(t);
  const before = readFileSync(manager.getSessionFile(), "utf8");
  for (const command of ["/edit 0", "/edit 2junk", "/edit 99"]) await session.prompt(command);
  assert.equal(readFileSync(manager.getSessionFile(), "utf8"), before);
  assert.equal(events.filter((event) => event.method === "notify" && event.notifyType === "error").length, 3);
  await session.prompt("/edit 2");
  assert.equal(manager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user"), false);
  assert.equal(events.findLast((event) => event.method === "set_editor_text")?.text, "first request");
});

test("/undo consumes the TUI journal layout and removes the same native turn", async (t) => {
  const { session, manager, last, cwd } = await setup(t);
  const changed = join(cwd, "changed.txt");
  const created = join(cwd, "created.txt");
  writeFileSync(changed, "after");
  writeFileSync(created, "new");
  const journal = join(root, "sessions", "undo", last);
  mkdirSync(join(journal, "files"), { recursive: true });
  mkdirSync(join(journal, "created"));
  writeFileSync(join(journal, "files", Buffer.from(changed).toString("base64url")), "before");
  writeFileSync(join(journal, "created", Buffer.from(created).toString("base64url")), "");
  await session.prompt("/undo");
  assert.equal(readFileSync(changed, "utf8"), "before");
  assert.equal(existsSync(created), false);
  assert.equal(manager.getEntry(last), undefined);
  assert.equal(existsSync(journal), false);
});

for (const command of ["context", "turns"]) test(`/${command} shows an interactive report without changing the stored conversation`, async (t) => {
  const { session, wrapper, manager, events } = await setup(t);
  const before = readFileSync(manager.getSessionFile(), "utf8");
  const showing = session.prompt(`/${command}`);
  for (let i = 0; i < 100 && !events.some((event) => event.method === "custom"); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const panel = events.find((event) => event.method === "custom");
  assert.ok(panel, "the Web custom UI receives the report");
  assert.match(panel.lines.join("\n"), command === "context" ? /Context Audit[\s\S]*Memory[\s\S]*Outfit/ : /Turns[\s\S]*first request[\s\S]*second request/);
  await wrapper.send({ type: "extension_ui_input", id: panel.id, data: "\r" });
  await showing;
  assert.equal(readFileSync(manager.getSessionFile(), "utf8"), before);
});

for (const multiSelect of [false, true]) test(`ask_user retains ${multiSelect ? "multiple choices" : "free-text answers"} through Web custom UI`, async (t) => {
  const { session, wrapper, manager, events, faux } = await setup(t);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("ask_user", {
      question: "Choose the output", options: [{ label: "HTML", description: "Editable page" }, { label: "PDF", description: "Printable document" }],
      multi_select: multiSelect,
    })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Answer received")]),
  ]);
  const prompting = session.prompt("Ask about the output");
  for (let i = 0; i < 200 && !events.some((event) => event.method === "custom"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const panel = events.find((event) => event.method === "custom");
  assert.ok(panel, "ask_user must use the complete interactive question dialog");
  assert.match(panel.lines.join("\n"), /Editable page[\s\S]*Printable document[\s\S]*Other/);
  const inputs = multiSelect ? ["1", "2", "\r"] : ["3", "Markdown instead", "\r"];
  for (const data of inputs) await wrapper.send({ type: "extension_ui_input", id: panel.id, data });
  await prompting;
  const result = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "toolResult");
  assert.ok(result);
  assert.equal(result.message.isError, false);
  assert.match(result.message.content[0].text, multiSelect ? /HTML, PDF/ : /Markdown instead/);
});

test("todo_write refreshes the live Web widget and /todo toggles the same panel", async (t) => {
  const { session, events, faux } = await setup(t);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("todo_write", { items: [{ content: "Inspect the implementation", status: "pending" }] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Plan ready")]),
  ]);
  await session.prompt("Plan the work");
  const widget = () => events.findLast((event) => event.method === "setWidget" && event.widgetKey === "todo");
  assert.match(widget().widgetLines.join("\n"), /Inspect the implementation/);
  await session.prompt("/todo");
  assert.doesNotMatch(widget().widgetLines.join("\n"), /Inspect the implementation/);
  await session.prompt("/todo");
  assert.match(widget().widgetLines.join("\n"), /Inspect the implementation/);
});

test("a native background command wakes only its Web session and keeps the completion stream pending", async (t) => {
  const a = await setup(t);
  const b = await setup(t);
  a.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.3; printf session-a-output", background: true })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Working in background")]),
    fauxAssistantMessage([fauxText("Background result received")]),
  ]);
  await a.session.prompt("start a background command");
  assert.ok(a.events.some((event) => event.type === "agent_settled" && event.subagentsActive === true));
  const notifications = (manager) => manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "background-task");
  for (let i = 0; i < 200 && notifications(a.manager).length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await a.session.agent.waitForIdle();
  assert.equal(notifications(a.manager).length, 1);
  assert.match(notifications(a.manager)[0].content, /session-a-output/);
  assert.equal(notifications(b.manager).length, 0);
  assert.equal(a.events.findLast((event) => event.type === "agent_settled").subagentsActive, undefined);
});
