import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text, type TUI, TuiAltScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

function createSettledTool(id: string, name: string, args: Record<string, unknown>, isError = false) {
	ToolExecutionComponent.compactMode = true;
	const component = new ToolExecutionComponent(
		name,
		id,
		args,
		{},
		undefined,
		{ requestRender: () => {} } as unknown as TUI,
		process.cwd(),
	);
	component.updateResult({ content: [{ type: "text", text: `detail-${id}` }], isError });
	return component;
}

function clickFirstLine(component: AssistantMessageComponent, needle: string, width = 80): void {
	const lines = component.render(width);
	const row = lines.findIndex((line) => stripAnsi(line).includes(needle));
	expect(row, `missing rendered line containing ${needle}`).toBeGreaterThanOrEqual(0);
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		// Past the nested-run guide prefix so both summary and tool rows accept the click.
		x: 5,
		y: row,
		screenX: 5,
		screenY: row,
		width,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	expect(component.handleMouse(event)?.handled, `click on ${needle}`).toBe(true);
}

function clickFirstThinkingLabel(component: AssistantMessageComponent, width = 80): void {
	clickFirstLine(component, "思考完成", width);
}

describe("AssistantMessageComponent", () => {
	test.each(["next message", "answer", "blank", "wheel", "focus out", "keyboard scroll"])(
		"restores a collapsed summary after %s",
		async (destination) => {
			initTheme("dark");
			const terminal = new VirtualTerminal(100, 16);
			const ui = new TuiAltScreen(terminal);
			const component = new AssistantMessageComponent(
				createAssistantMessage([
					{ type: "thinking", thinking: "reasoning" },
					{ type: "text", text: "answer" },
				]),
			);
			ui.addChild(component);
			ui.addChild(new Text("next message", 0, 0));
			ui.start();
			try {
				await terminal.waitForRender();
				const idle = component.render(100);
				const row = terminal.getViewport().findIndex((line) => line.includes("思考完成"));
				expect(row).toBeGreaterThanOrEqual(0);
				terminal.sendInput(`\x1b[<35;6;${row + 1}M`);
				await terminal.waitForRender();
				expect(component.render(100)).not.toEqual(idle);
				terminal.sendInput(`\x1b[<35;7;${row + 1}M`);
				await terminal.waitForRender();
				expect(component.render(100)).not.toEqual(idle);
				if (destination === "wheel") terminal.sendInput("\x1b[<65;6;1M");
				else if (destination === "focus out") terminal.sendInput("\x1b[O");
				else if (destination === "keyboard scroll") ui.scrollToTop();
				else {
					const nextRow =
						destination === "blank" ? 15 : terminal.getViewport().findIndex((line) => line.includes(destination));
					terminal.sendInput(`\x1b[<35;6;${nextRow + 1}M`);
				}
				await terminal.waitForRender();
				expect(component.render(100)).toEqual(idle);
			} finally {
				ui.stop();
			}
		},
	);

	test("shows completed thinking through the keyboard visibility setting", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first reasoning" },
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "second reasoning" },
			]),
		);
		component.setHideThinkingBlock(false);
		const visible = stripAnsi(component.render(100).join("\n"));
		expect(visible).toContain("first reasoning");
		expect(visible).toContain("second reasoning");
		component.setHideThinkingBlock(true);
		const hidden = stripAnsi(component.render(100).join("\n"));
		expect(hidden).not.toContain("first reasoning");
		expect(hidden).not.toContain("second reasoning");
	});
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops with neutral truncation wording", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("思考完成");
		expect(rendered).toContain("Response was truncated before completion.");
	});

	test("coalesces adjacent thinking blocks into one hidden thinking label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.match(/思考完成/g)).toHaveLength(1);
		expect(rendered).toContain("answer");
	});

	test("expands active thinking and collapses it when the response completes", () => {
		initTheme("dark");
		const pending = createAssistantMessage([{ type: "thinking", thinking: "live reasoning" }], {
			stopReason: "pending",
		});
		const component = new AssistantMessageComponent(pending);

		const active = stripAnsi(component.render(80).join("\n"));
		expect(active).toContain("思考中");
		expect(active).toContain("live reasoning");
		expect(active).toContain("切换思考显示");

		const done = createAssistantMessage([{ type: "thinking", thinking: "live reasoning" }], { stopReason: "stop" });
		component.updateContent(done, false);
		const completed = stripAnsi(component.render(80).join("\n"));
		expect(completed).toContain("思考完成");
		expect(completed).toContain("切换思考显示");
		expect(completed).not.toContain("live reasoning");
	});

	test("uses the animated loader only for active thinking and stops it on completion", () => {
		initTheme("dark");
		const pending = createAssistantMessage([{ type: "thinking", thinking: "live reasoning" }], {
			stopReason: "pending",
		});
		const component = new AssistantMessageComponent(
			pending,
			false,
			undefined,
			"∴ Thinking",
			1,
			[],
			undefined,
			undefined,
			"思考完成",
			{ requestRender: () => {} } as unknown as TUI,
		);
		const active = stripAnsi(component.render(80).join("\n"));
		expect(active).toMatch(/[∴∵⋯…] Thinking/);
		expect(active).not.toContain("∴ ∴");
		expect(active).toContain("live reasoning");

		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "live reasoning" }], { stopReason: "stop" }),
			false,
		);
		const completed = stripAnsi(component.render(80).join("\n"));
		expect(completed).toContain("思考完成");
		expect(completed).not.toContain("live reasoning");
	});

	test("expands and collapses individual thinking runs when clicked", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first reasoning" },
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "second reasoning" },
			]),
		);
		const initial = stripAnsi(component.render(80).join("\n"));
		expect(initial).not.toContain("first reasoning");
		expect(initial).not.toContain("second reasoning");
		expect(initial.match(/思考完成/g)).toHaveLength(2);

		clickFirstThinkingLabel(component);
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain("first reasoning");
		expect(expanded).not.toContain("second reasoning");

		clickFirstThinkingLabel(component);
		const collapsed = stripAnsi(component.render(80).join("\n"));
		expect(collapsed).not.toContain("first reasoning");
		expect(collapsed).not.toContain("second reasoning");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes("思考完成"))).toBe(true);
		clickFirstThinkingLabel(component);
		expect(stripAnsi(component.render(80).join("\n"))).toContain(" reasoning");

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		// The ⏺ glyph shares the first line with the text, like Claude Code.
		expect(updatedLines.some((line) => line.startsWith("⏺ hello"))).toBe(true);
		expect(updatedLines.some((line) => line.includes("reasoning"))).toBe(true);
	});

	test("chains Markdown transformers in registration order", () => {
		initTheme("dark");
		const calls: string[] = [];
		const message = createAssistantMessage([{ type: "text", text: "The result is $x^2$." }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "assistant", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The result is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("identifies partial assistant Markdown as streaming", () => {
		initTheme("dark");
		const streamingStates: boolean[] = [];
		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				streamingStates.push(context.isStreaming);
				return context.isStreaming ? markdown : `${markdown} transformed`;
			},
		]);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("transformed");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial transformed");
		expect(streamingStates).toEqual([true, false]);
	});

	test("reapplies Markdown transformers when available width changes", () => {
		initTheme("dark");
		const availableWidths: number[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "answer" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown, context) => {
					availableWidths.push(context.availableWidth);
					return `${markdown} (${context.availableWidth})`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("answer (78)");
		component.render(80);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("answer (58)");
		expect(availableWidths).toEqual([78, 58]);
	});

	test("continues the Markdown transformer chain when a transformer throws", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "still visible" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown) => {
					calls.push("first");
					return markdown.replace("still", "remains");
				},
				() => {
					calls.push("throw");
					throw new Error("broken transformer");
				},
				(markdown) => {
					calls.push("last");
					return `${markdown} after error`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("remains visible after error");
		expect(calls).toEqual(["first", "throw", "last"]);
	});

	test("transforms text and thinking Markdown without mutating the original message", () => {
		initTheme("dark");
		const message = createAssistantMessage([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, { messageType }) => {
				return `${messageType}:${markdown}`;
			},
		]);

		clickFirstThinkingLabel(component);
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("assistant:answer");
		expect(rendered).toContain("assistant-thinking:reasoning");
		expect(message.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		// Upstream shape: full-width padded background block (no left bar).
		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.includes("hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.includes("hello"))).toBe(true);
	});

	test("spells out memory and continuity calls in the thinking label instead of counting them", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "worth saving" },
				{
					type: "toolCall",
					id: "t1",
					name: "memory_write",
					arguments: { type: "promise", title: "周一MOSS下载约定", body: "..." },
				},
				{
					type: "toolCall",
					id: "t2",
					name: "memory_write",
					arguments: { type: "episode", title: "v4a定稿", body: "..." },
				},
				{ type: "toolCall", id: "t3", name: "continuity_update", arguments: { summary: "阶段摘要" } },
				{ type: "toolCall", id: "t4", name: "bash", arguments: { command: "ls" } },
			]),
		);
		const rendered = stripAnsi(component.render(160).join("\n"));

		expect(rendered).toContain("记忆：周一MOSS下载约定 · v4a定稿");
		expect(rendered).toContain("连续性已更新");
		expect(rendered).toContain("命令 1 次");
		expect(rendered).not.toContain("工具 4 次");
	});

	test("separates shell and other tool counts when no memory tools follow thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "acting" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } },
			]),
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("命令 1 次 · 工具 1 次");
		expect(rendered).not.toContain("工具 2 次");
	});

	test("counts memory calls across interleaved text like Claude Code aggregates a turn", () => {
		initTheme("dark");

		// Real wire shape: the model explains first, then writes memory at the
		// end of the run. Claude Code labels the whole turn the same way.
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "答复正文之后写记忆" },
				{ type: "text", text: "对完了，这一轮的结果如下……" },
				{
					type: "toolCall",
					id: "t1",
					name: "memory_write",
					arguments: { type: "promise", title: "周一MOSS下载约定", body: "..." },
				},
				{ type: "toolCall", id: "t2", name: "continuity_update", arguments: { summary: "阶段摘要" } },
			]),
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("记忆：周一MOSS下载约定");
		expect(rendered).toContain("连续性已更新");
		expect(rendered).toContain("对完了");
		expect(rendered).not.toContain("工具 1 次");
	});

	test("keeps the plain label when a thinking run is followed by text with no tools", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "final answer" },
				{ type: "text", text: "just the answer" },
			]),
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("思考完成");
		expect(rendered).not.toContain("ran");
	});

	test("falls back to a generic memory mention while write arguments are incomplete", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "saving" },
				{ type: "toolCall", id: "t1", name: "memory_write", arguments: {} },
			]),
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("记忆：已更新");
	});

	test("expands a thought group into a thought preview and sibling tool rows", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "preview-start\nline two\nline three\nline four\nTAIL-FULL-ONLY" },
				{ type: "text", text: "正文在组外" },
				{ type: "toolCall", id: "m1", name: "memory_write", arguments: { title: "工程经验（分域）" } },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
			]),
		);
		component.registerToolComponent(createSettledTool("m1", "memory_write", { title: "工程经验（分域）" }));
		component.registerToolComponent(createSettledTool("b1", "bash", { command: "ls" }));

		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).not.toContain("preview-start");
		expect(collapsed).not.toContain("memory_write");
		expect(collapsed).not.toContain("bash ·");

		clickFirstThinkingLabel(component, 100);
		const lines = component.render(100).map((line) => stripAnsi(line));
		const expanded = lines.join("\n");
		expect(expanded).toContain("preview-start");
		expect(expanded).not.toContain("TAIL-FULL-ONLY");
		expect(expanded).toContain("点击思考正文显示全部");
		expect(expanded).toContain("memory_write");
		expect(expanded).toContain("bash · ls");

		const previewRow = lines.findIndex((line) => line.includes("preview-start"));
		const memoryRow = lines.findIndex((line) => line.includes("memory_write"));
		const shellRow = lines.findIndex((line) => line.includes("bash ·"));
		const proseRow = lines.findIndex((line) => line.includes("正文在组外"));
		expect(previewRow).toBeLessThan(memoryRow);
		expect(memoryRow).toBeLessThan(shellRow);
		expect(shellRow).toBeLessThan(proseRow);

		const summaryRow = lines.findIndex((line) => line.includes("思考完成"));
		expect(lines[summaryRow + 1]?.trim()).toBe("│");
		expect(lines[previewRow]?.startsWith(" │ ")).toBe(true);
		expect(lines[memoryRow]?.startsWith(" │ ")).toBe(true);
		expect(lines[memoryRow - 1]?.trim()).toBe("│");
		expect(lines[proseRow - 1]?.trim()).toBe("");
	});

	test("brightens the thought summary on hover and dims it again when the pointer leaves", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "hoverable summary" },
				{ type: "text", text: "正文" },
			]),
		);
		const findRow = (needle: string) => {
			const lines = component.render(80).map((line) => stripAnsi(line));
			const row = lines.findIndex((line) => line.includes(needle));
			expect(row).toBeGreaterThanOrEqual(0);
			return row;
		};
		const idleRow = findRow("思考完成");
		const colorPrefix = (token: "thinkingText" | "text") => theme.fg(token, "x").match(/^\x1b\[[\d;]+m/)?.[0] ?? "";
		const idleRendered = component.render(80)[idleRow]!;
		expect(idleRendered).toContain(colorPrefix("thinkingText"));
		expect(idleRendered).not.toContain(colorPrefix("text"));
		clickFirstThinkingLabel(component);

		const move = (row: number): void => {
			const lines = component.render(80);
			const result = component.handleMouse({
				type: "move",
				button: "none",
				x: 5,
				y: row,
				screenX: 5,
				screenY: row,
				width: 80,
				height: lines.length,
				shift: false,
				alt: false,
				ctrl: false,
			});
			expect(result?.handled).toBe(true);
		};
		move(idleRow);
		const hoveredRendered = component.render(80)[findRow("思考完成")]!;
		expect(hoveredRendered).toContain(colorPrefix("text"));
		expect(hoveredRendered).not.toContain(colorPrefix("thinkingText"));

		move(findRow("hoverable summary"));
		const restoredRendered = component.render(80)[findRow("思考完成")]!;
		expect(restoredRendered).toContain(colorPrefix("thinkingText"));
		expect(restoredRendered).not.toContain(colorPrefix("text"));
	});

	test("expands thought and tool details independently within the same group", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "preview-start\nline two\nline three\nline four\nTAIL-FULL-ONLY" },
				{ type: "text", text: "正文" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
			]),
		);
		component.registerToolComponent(createSettledTool("b1", "bash", { command: "ls" }));
		clickFirstThinkingLabel(component);

		clickFirstLine(component, "bash ·");
		const toolDetails = stripAnsi(component.render(80).join("\n"));
		expect(toolDetails).toContain("detail-b1");
		expect(toolDetails).not.toContain("TAIL-FULL-ONLY");

		clickFirstLine(component, "preview-start");
		const fullThought = stripAnsi(component.render(80).join("\n"));
		expect(fullThought).toContain("TAIL-FULL-ONLY");
		expect(fullThought).toContain("detail-b1");

		clickFirstThinkingLabel(component);
		clickFirstThinkingLabel(component);
		const reopened = stripAnsi(component.render(80).join("\n"));
		expect(reopened).toContain("bash ·");
		expect(reopened).not.toContain("detail-b1");
		expect(reopened).not.toContain("TAIL-FULL-ONLY");
	});

	test("keeps running, failed, verbose, and ungrouped tools visible", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "tool states" },
				{ type: "text", text: "正文" },
				{ type: "toolCall", id: "r1", name: "bash", arguments: { command: "sleep 1" } },
				{ type: "toolCall", id: "f1", name: "memory_write", arguments: { title: "冲突" } },
				{ type: "toolCall", id: "s1", name: "read", arguments: { path: "a.ts" } },
			]),
		);
		ToolExecutionComponent.compactMode = true;
		const running = new ToolExecutionComponent(
			"bash",
			"r1",
			{ command: "sleep 1" },
			{},
			undefined,
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		component.registerToolComponent(running);
		component.registerToolComponent(createSettledTool("f1", "memory_write", { title: "冲突" }, true));
		component.registerToolComponent(createSettledTool("s1", "read", { path: "a.ts" }));

		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).toContain("bash");
		expect(collapsed).toContain("memory_write");
		expect(collapsed).not.toContain("read ·");

		running.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		component.refreshToolVisibility();
		const settled = stripAnsi(component.render(100).join("\n"));
		expect(settled).not.toContain("bash ·");
		expect(settled).toContain("memory_write");

		ToolExecutionComponent.compactMode = false;
		component.refreshToolVisibility();
		expect(stripAnsi(component.render(100).join("\n"))).toContain("read");
		ToolExecutionComponent.compactMode = true;

		const ungrouped = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "没有思考也要看见工具" },
				{ type: "toolCall", id: "u1", name: "read", arguments: { path: "b.ts" } },
			]),
		);
		ungrouped.registerToolComponent(createSettledTool("u1", "read", { path: "b.ts" }));
		expect(stripAnsi(ungrouped.render(100).join("\n"))).toContain("read · b.ts");
	});

	test("separates the thought summary and assistant prose with a blank line", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "independent section" },
				{ type: "text", text: "正文从这里开始" },
			]),
		);
		const lines = component.render(80).map((line) => stripAnsi(line));
		const thoughtRow = lines.findIndex((line) => line.includes("思考完成"));
		const proseRow = lines.findIndex((line) => line.includes("正文从这里开始"));

		expect(thoughtRow).toBeGreaterThanOrEqual(0);
		expect(proseRow).toBe(thoughtRow + 2);
		expect(lines[thoughtRow + 1]?.trim()).toBe("");
	});
});
