import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const delivered =
	"下好了吗\n\n<message_time>2026-10-27T12:33:00+08:00 (Tuesday, 27/10/2026, 12:33:00, Asia/Shanghai)</message_time>";
const addMessage = (
	InteractiveMode.prototype as unknown as {
		addMessageToChat(message: AgentMessage): AssistantMessageComponent | undefined;
	}
).addMessageToChat;

describe("query and injection layout", () => {
	test.each([false, true])(
		"groups injected context with its query before the first tool (expanded=%s)",
		(expanded) => {
			initTheme("dark");
			const chatContainer = new Container();
			const context = {
				chatContainer,
				outputPad: 1,
				toolOutputExpanded: expanded,
				getUserMessageText: () => delivered,
				getMarkdownThemeWithSettings: getMarkdownTheme,
				getMarkdownTransformers: () => [],
			};
			addMessage.call(context, { role: "user", content: delivered, timestamp: 0 });
			expect(chatContainer.children).toHaveLength(1);
			expect(chatContainer.children[0]).toBeInstanceOf(UserMessageComponent);
			const input = chatContainer.render(120).map(stripAnsi);
			const queryRow = input.findIndex((line) => line.includes("下好了吗"));
			const injectionRow = input.findIndex((line) => line.includes(expanded ? "注入上下文" : "runtime-context"));
			expect(injectionRow).toBe(queryRow + 1);
			expect(input[injectionRow].startsWith("   ")).toBe(true);
			const user = chatContainer.children[0] as UserMessageComponent;
			user.setExpanded(!expanded);
			expect(stripAnsi(user.render(120).join("\n")).includes("<message_time>")).toBe(!expanded);
			user.setOutputPad(0);
			const resized = user.render(120).map(stripAnsi);
			expect(
				resized.find((line) => line.includes(!expanded ? "注入上下文" : "runtime-context"))?.startsWith("  "),
			).toBe(true);
		},
	);

	test("separates a tool-only first assistant response from injected metadata", () => {
		initTheme("dark");
		const chatContainer = new Container();
		const context = {
			chatContainer,
			outputPad: 1,
			toolOutputExpanded: false,
			hideThinkingBlock: true,
			getUserMessageText: () => delivered,
			getMarkdownThemeWithSettings: getMarkdownTheme,
			getMarkdownTransformers: () => [],
			ui: { requestRender: () => {} } as unknown as TUI,
		};
		addMessage.call(context, { role: "user", content: delivered, timestamp: 0 });
		const assistant = addMessage.call(context, {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "test",
			timestamp: 0,
			content: [{ type: "toolCall", id: "first", name: "bash", arguments: { command: "ls" } }],
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		expect(assistant).toBeDefined();
		const tool = new ToolExecutionComponent(
			"bash",
			"first",
			{ command: "ls" },
			{},
			undefined,
			context.ui,
			process.cwd(),
		);
		assistant!.registerToolComponent(tool);
		const lines = chatContainer.render(120).map(stripAnsi);
		const injectionRow = lines.findIndex((line) => line.includes("runtime-context"));
		const toolRow = lines.findIndex((line) => line.includes("bash"));
		expect(toolRow).toBeGreaterThan(injectionRow + 1);
		expect(lines[toolRow - 1].trim()).toBe("");
	});
});
