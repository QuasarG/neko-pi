import type { AgentSession, ExtensionContext, ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import { parseInjectedContext } from "@earendil-works/pi-coding-agent/injected-context";
import {
  CONTINUITY_TTL_MS, getMemoryChannel, getRuntimeState, loadPersonaPack,
  pendingDeliveryScopes, resolveProjectIdentity, restoreTurn, scopeKey, truncateNativeSession,
  type MemoryScope,
} from "@earendil-works/pi-coding-agent/runtime";
import { Text } from "@earendil-works/pi-tui";

export function createNekoSessionCommands(getSession: () => AgentSession): InlineExtension {
  const factory: ExtensionFactory = (pi) => {
    const showReport = (title: string, body: string, ctx: ExtensionContext) => ctx.ui.custom<void>((_tui, _theme, keys, done) => {
      const content = new Text(`${title}\n\n${body}\n\nEnter / Esc to close`, 1, 1);
      return {
        render: (width: number) => content.render(width),
        invalidate: () => content.invalidate(),
        handleInput: (data: string) => {
          if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm")) done();
        },
      };
    });

    for (const name of ["edit", "undo"] as const) pi.registerCommand(name, {
      description: name === "edit" ? "Remove a user turn and refill the composer: /edit [nth-from-last]" : "Undo the last turn and its write/edit file changes",
      handler: async (args, ctx) => {
        const session = getSession();
        if (session.isStreaming || session.isCompacting || session.isBashRunning) {
          ctx.ui.notify(`Wait for the running response to finish before ${name === "edit" ? "editing" : "undoing"}.`, "error");
          return;
        }
        const nth = name === "undo" || !args.trim() ? 1 : Number(args.trim());
        if (!Number.isSafeInteger(nth) || nth < 1) {
          ctx.ui.notify("Usage: /edit [nth-from-last] (e.g. /edit 2)", "error");
          return;
        }
        const users = session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user");
        const target = users.at(-nth);
        if (target?.type !== "message" || target.message.role !== "user") {
          ctx.ui.notify(`No user message #${nth} from the end.`, "error");
          return;
        }
        const raw = typeof target.message.content === "string" ? target.message.content
          : target.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
        const files = name === "undo" ? restoreTurn(target.id) : undefined;
        await truncateNativeSession(session, target.id);
        const ui = session.extensionRunner.createContext().ui;
        if (name === "edit") ui.setEditorText(parseInjectedContext(raw)?.userText ?? raw);
        ui.notify(files
          ? `Undo: restored ${files.restored.length} file(s), deleted ${files.deleted.length} created file(s), removed the turn. Bash-driven changes are not rolled back.`
          : "Removed the turn and refilled the composer — edit and resend.", "info");
      },
    });

    pi.registerCommand("turns", {
      description: "Show the active branch's user turns, replies and tool calls",
      handler: async (_args, ctx) => {
        const lines: string[] = [];
        let turn = 0;
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type !== "message") continue;
          const message = entry.message;
          if (message.role !== "user" && message.role !== "assistant") continue;
          const raw = typeof message.content === "string" ? message.content
            : message.content.filter((block) => block.type === "text").map((block) => block.text).join(" ");
          const text = (parseInjectedContext(raw)?.userText ?? raw).replace(/\s+/g, " ").trim().slice(0, 120);
          const calls = Array.isArray(message.content) ? message.content.filter((block) => block.type === "toolCall").length : 0;
          lines.push(`${message.role === "user" ? `#${++turn}` : "  →"} ${text}${calls ? ` (${calls} tool calls)` : ""}`);
        }
        await showReport("Turns", lines.join("\n") || "No turns yet.", ctx);
      },
    });

    pi.registerCommand("context", {
      description: "Audit persona, memory delivery, continuity, outfit and recent activity",
      handler: async (_args, ctx) => {
        const state = getRuntimeState();
        const channel = getMemoryChannel();
        const pack = loadPersonaPack();
        const projectScope: MemoryScope = { scope: "project", projectId: resolveProjectIdentity(ctx.cwd).projectId };
        const pending = pendingDeliveryScopes({ sessionId: ctx.sessionManager.getSessionId() ?? "", projectScope, channel });
        const scopes: MemoryScope[] = [{ scope: "persona" }, { scope: "toolbox" }, projectScope];
        const memory = scopes.map((scope) => {
          const records = channel.store(scope).list(true);
          return `${scopeKey(scope)}: v${state.scopeVersion(scope)} · ${records.length} records · ${records.reduce((total, record) => total + Buffer.byteLength(record.body), 0)} B · ${pending.has(scopeKey(scope)) ? "changes pending injection" : "delivered"}`;
        });
        const continuity = state.getContinuity("persona");
        await showReport("Context Audit", [
          `Persona: ${pack ? `${pack.name} · identity ${Buffer.byteLength(pack.identity)} B · voice ${Buffer.byteLength(pack.voice ?? "")} B` : "No persona pack installed"}`,
          "", "Memory", ...memory, "", "Continuity note",
          continuity?.content && Date.now() - continuity.updated < CONTINUITY_TTL_MS ? continuity.content : "empty or expired",
          "", `Outfit: ${state.getWardrobeState().current ?? "none"}`,
          "", "Recent activity", ...state.activitiesSince(0, projectScope.projectId, 10).events.map((event) => `- ${event.kind}`),
        ].join("\n"), ctx);
      },
    });
  };
  return { name: "neko-web-commands", factory, builtin: true };
}
