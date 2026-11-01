import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Loader,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { ASSISTANT_GLYPH, createMarkdownTransform, glyphPrefixedMarkdown } from "./markdown-transform.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

const THINKING_FRAMES = ["∴", "∵", "⋯", "…"];
const THINKING_PREVIEW_LINES = 4;
const THINKING_PREVIEW_CHARS = 500;

type ThinkingExpansion = "collapsed" | "preview" | "full";

/** Indents a child under the thought summary and draws a quiet left guide. */
class NestedRunComponent implements Component {
	private readonly child: Component;
	private readonly indent: number;

	constructor(child: Component, indent: number) {
		this.child = child;
		this.indent = indent;
	}

	render(width: number): string[] {
		const available = Math.max(1, width - this.indent - 2);
		const prefix = `${" ".repeat(this.indent)}${theme.fg("borderMuted", "│ ")}`;
		return this.child.render(available).map((line) => prefix + line);
	}

	handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.x < this.indent + 2) return undefined;
		const result = this.child.handleMouse?.({
			...event,
			x: event.x - this.indent - 2,
			width: Math.max(1, event.width - this.indent - 2),
		});
		return result ? ({ handled: true } as ReturnType<Container["handleMouse"]>) : undefined;
	}

	invalidate(): void {
		this.child.invalidate?.();
	}
}

/** Animated label used only while the model is actually thinking. */
class ThinkingLoader extends Loader {
	constructor(ui: TUI, outputPad: number) {
		super(
			ui,
			(text) => theme.fg("accent", text),
			(text) => theme.fg("thinkingText", text),
			"",
			{ frames: THINKING_FRAMES, intervalMs: 180 },
		);
		this.setPaddingX(outputPad);
	}

	protected override getRenderedIndicator(): string {
		return theme.fg("accent", super.getRenderedIndicator());
	}

	override render(width: number): string[] {
		// Loader reserves a blank line for standalone status rows; an inline
		// thinking label belongs directly above its own content.
		return super.render(width).slice(1);
	}
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private doneThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private messageId?: string;
	private timestamp?: string;
	private thinkingExpansionOverrides = new Map<number, ThinkingExpansion>();
	private thinkingHoverRun: number | undefined;
	private ui?: TUI;
	private thinkingLoader?: ThinkingLoader;
	private thinkingLoaderRunIndex?: number;
	private toolComponents = new Map<string, ToolExecutionComponent>();

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "思考中",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
		doneThinkingLabel = "思考完成",
		ui?: TUI,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.doneThinkingLabel = doneThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.ui = ui;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingExpansionOverrides.clear();
		if (this.lastMessage) {
			let runIndex = 0;
			let inRun = false;
			for (const block of this.lastMessage.content) {
				if (block.type !== "thinking") {
					inRun = false;
				} else if (block.thinking.trim() && !inRun) {
					this.thinkingExpansionOverrides.set(runIndex++, hide ? "collapsed" : "full");
					inRun = true;
				}
			}
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setDoneThinkingLabel(label: string): void {
		this.doneThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.thinkingLoader?.setPaddingX(padding);
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/** Attach a tool row to the thinking run that summarizes it. */
	registerToolComponent(component: ToolExecutionComponent): void {
		this.toolComponents.set(component.getToolCallId(), component);
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	getToolComponents(): readonly ToolExecutionComponent[] {
		return [...this.toolComponents.values()];
	}

	ownsToolCall(toolCallId: string): boolean {
		return this.toolComponents.has(toolCallId);
	}

	/** Re-evaluate running/failed visibility after a tool result arrives. */
	refreshToolVisibility(): void {
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	/** Open only the groups that own tools, preserving fully expanded thoughts. */
	revealToolGroups(): void {
		if (!this.lastMessage || this.toolComponents.size === 0) return;
		let runIndex = 0;
		for (let i = 0; i < this.lastMessage.content.length; i++) {
			if (this.lastMessage.content[i]?.type !== "thinking") continue;
			let hasThinking = false;
			for (; i < this.lastMessage.content.length; i++) {
				const block = this.lastMessage.content[i];
				if (block?.type !== "thinking") break;
				if (block.thinking.trim()) hasThinking = true;
			}
			i--;
			if (!hasThinking) continue;
			const currentRun = runIndex++;
			let hasRegisteredTool = false;
			for (let j = i + 1; j < this.lastMessage.content.length; j++) {
				const block = this.lastMessage.content[j];
				if (!block || (block.type === "thinking" && block.thinking.trim())) break;
				if (block.type === "toolCall" && this.toolComponents.has(block.id)) hasRegisteredTool = true;
			}
			if (hasRegisteredTool && this.thinkingExpansionOverrides.get(currentRun) !== "full") {
				this.thinkingExpansionOverrides.set(currentRun, "preview");
			}
		}
		this.updateContent(this.lastMessage);
	}

	private stopThinkingLoader(): void {
		this.thinkingLoader?.stop();
		this.thinkingLoader = undefined;
		this.thinkingLoaderRunIndex = undefined;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) =>
				(c.type === "text" && c.text.trim()) ||
				(c.type === "thinking" && c.thinking.trim()) ||
				c.type === "toolCall",
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let thinkingRunIndex = 0;
		let activeThinkingRunIndex: number | undefined;
		const groupedToolCallIds = new Set<string>();
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Claude Code style: the ⏺ dot shares the first line with the text.
				// The Markdown keeps paddingY=0 to avoid extra spacing before tools.
				const glyph = glyphPrefixedMarkdown(content.text.trim(), ASSISTANT_GLYPH);
				if (!glyph.inline) {
					this.contentContainer.addChild(new Text(theme.fg("text", `${ASSISTANT_GLYPH} `), this.outputPad, 0));
				}
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: (markdown, availableWidth) => {
							const transformed = createMarkdownTransform(
								"assistant",
								this.isStreaming,
								this.markdownTransformers,
								this.messageId,
								this.timestamp,
							)(markdown, availableWidth);
							return glyph.inline ? glyphPrefixedMarkdown(transformed, ASSISTANT_GLYPH).text : transformed;
						},
					}),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Claude Code stores each content block as its own record and
				// aggregates a whole turn under one label ("Thought · ran N
				// tools") followed by the text. The model emits
				// thinking -> text -> toolCall inside one message, so the label
				// must count tool calls across the interleaved text, stopping
				// only at the next thinking run. Collapsing the label tucks all
				// of those tool rows into it; expanding brings them back.
				// Memory writes and continuity updates change user-visible
				// state, so their titles are spelled out in the label.
				const memoryTitles: string[] = [];
				const runToolCallIds: string[] = [];
				let continuityUpdates = 0;
				let shellCommands = 0;
				let otherToolCalls = 0;
				for (let j = i + 1; j < message.content.length; j++) {
					const next = message.content[j];
					if (next.type === "thinking" && next.thinking.trim()) break;
					if (next.type !== "toolCall") continue;
					runToolCallIds.push(next.id);
					if (next.name === "memory_write") {
						const title = next.arguments.title;
						memoryTitles.push(typeof title === "string" && title.trim() ? title.trim() : "已更新");
					} else if (next.name === "continuity_update") {
						continuityUpdates++;
					} else if (next.name === "bash") {
						shellCommands++;
					} else {
						otherToolCalls++;
					}
				}
				const runIndex = thinkingRunIndex++;
				const remainingContent = message.content.slice(i + 1);
				const hasVisibleContentAfter = remainingContent.some(
					(c) =>
						(c.type === "text" && c.text.trim()) ||
						(c.type === "thinking" && c.thinking.trim()) ||
						c.type === "toolCall",
				);
				const hasReadableContentAfter = remainingContent.some(
					(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
				);
				const active = message.stopReason === "pending" && !hasVisibleContentAfter;
				const expansion: ThinkingExpansion =
					this.thinkingExpansionOverrides.get(runIndex) ??
					(active ? (this.hideThinkingBlock ? "collapsed" : "full") : "collapsed");
				for (const id of runToolCallIds) groupedToolCallIds.add(id);
				const runTools = runToolCallIds
					.map((id) => this.toolComponents.get(id))
					.filter((component): component is ToolExecutionComponent => component !== undefined);
				const summaryParts: string[] = [];
				if (memoryTitles.length > 0) summaryParts.push(`记忆：${memoryTitles.join(" · ")}`);
				if (continuityUpdates > 0) summaryParts.push("连续性已更新");
				if (shellCommands > 0) summaryParts.push(`命令 ${shellCommands} 次`);
				if (otherToolCalls > 0) summaryParts.push(`工具 ${otherToolCalls} 次`);
				const label = active
					? this.hiddenThinkingLabel
					: summaryParts.length > 0
						? `${this.doneThinkingLabel} · ${summaryParts.join(" · ")}`
						: this.doneThinkingLabel;
				const hint = keyHint("app.thinking.toggle", "切换思考显示");
				const thinkingText = thinkingBlocks.join("\n\n");
				const createThinkingMarkdown = (text: string) =>
					new Markdown(
						text,
						this.outputPad,
						0,
						this.markdownTheme,
						{
							color: (text: string) => theme.fg("muted", text),
						},
						{
							transform: createMarkdownTransform(
								"assistant-thinking",
								this.isStreaming,
								this.markdownTransformers,
								this.messageId,
								this.timestamp,
							),
						},
					);

				let labelComponent: Component;
				if (active && this.ui) {
					if (!this.thinkingLoader || this.thinkingLoaderRunIndex !== runIndex) {
						this.stopThinkingLoader();
						this.thinkingLoader = new ThinkingLoader(this.ui, this.outputPad);
						this.thinkingLoaderRunIndex = runIndex;
					}
					this.thinkingLoader.setMessage(`${label.replace(/^(?:∴|✻)\s+/, "")} (${hint})`);
					labelComponent = this.thinkingLoader;
				} else {
					const hovered = this.thinkingHoverRun === runIndex;
					const disclosure = expansion === "collapsed" ? "▸" : "▾";
					const action = expansion === "collapsed" ? "展开" : "收起";
					const labelText = `${theme.fg(hovered ? "text" : "thinkingText", `${disclosure} ${label}`)} ${theme.fg("dim", `· 点击${action}`)} · ${hint}`;
					labelComponent = new Text(labelText, this.outputPad, 0);
				}

				const thinkingGroup = new Container();
				thinkingGroup.addChild(
					new MouseRegion(
						labelComponent,
						(event) => {
							if (event.type === "move") {
								if (this.thinkingHoverRun === runIndex) return { handled: true, render: false };
								this.thinkingHoverRun = runIndex;
								if (this.lastMessage) this.updateContent(this.lastMessage);
								return { handled: true, render: true };
							}
							if (event.type !== "click" || event.button !== "left") return undefined;
							if (expansion !== "collapsed" && ToolExecutionComponent.compactMode) {
								for (const tool of runTools) tool.setExpanded(false);
							}
							this.thinkingExpansionOverrides.set(runIndex, expansion === "collapsed" ? "preview" : "collapsed");
							if (this.lastMessage) this.updateContent(this.lastMessage);
							return { handled: true };
						},
						() => {
							if (this.thinkingHoverRun === undefined) return;
							this.thinkingHoverRun = undefined;
							if (this.lastMessage) this.updateContent(this.lastMessage);
						},
					),
				);

				if (expansion !== "collapsed") {
					let bodyComponent: Component;
					if (expansion === "full") {
						bodyComponent = createThinkingMarkdown(thinkingText);
					} else {
						const previewLines = thinkingText.split("\n");
						let previewText = previewLines.slice(0, THINKING_PREVIEW_LINES).join("\n");
						let previewTruncated = previewLines.length > THINKING_PREVIEW_LINES;
						if (previewText.length > THINKING_PREVIEW_CHARS) {
							previewText = previewText.slice(0, THINKING_PREVIEW_CHARS).trimEnd();
							previewTruncated = true;
						}
						const previewGroup = new Container();
						previewGroup.addChild(createThinkingMarkdown(previewText));
						if (previewTruncated) {
							previewGroup.addChild(new Text(theme.fg("muted", "… 点击思考正文显示全部"), this.outputPad, 0));
						}
						bodyComponent = previewGroup;
					}
					const bodyGroup = new Container();
					bodyGroup.addChild(new Spacer(1));
					bodyGroup.addChild(
						new MouseRegion(bodyComponent, (event) => {
							if (event.type !== "click" || event.button !== "left") return undefined;
							this.thinkingExpansionOverrides.set(runIndex, expansion === "full" ? "preview" : "full");
							if (this.lastMessage) this.updateContent(this.lastMessage);
							return { handled: true };
						}),
					);
					thinkingGroup.addChild(new NestedRunComponent(bodyGroup, this.outputPad));
				}

				const showAllTools = expansion !== "collapsed" || !ToolExecutionComponent.compactMode;
				// Subagent cards stay visible even when quiet: they are the
				// progress surface for delegated work (status, elapsed, result),
				// not noise to fold under the Thought summary.
				const visibleTools = runTools.filter(
					(tool) => showAllTools || tool.name === "subagent" || !tool.hasSettledResult() || tool.hasFailedResult(),
				);
				if (visibleTools.length > 0) {
					const toolGroup = new Container();
					if (expansion !== "collapsed") toolGroup.addChild(new Spacer(1));
					for (const tool of visibleTools) toolGroup.addChild(tool);
					thinkingGroup.addChild(
						new NestedRunComponent(toolGroup, expansion === "collapsed" ? 0 : this.outputPad),
					);
				}
				const hoverAwareGroup = new MouseRegion(thinkingGroup, (event) => {
					if (event.type !== "move" || this.thinkingHoverRun === undefined) return undefined;
					this.thinkingHoverRun = undefined;
					if (this.lastMessage) this.updateContent(this.lastMessage);
					return { handled: true, render: true };
				});
				this.contentContainer.addChild(hoverAwareGroup);
				// Keep the thought/tool summary as its own quiet section. The
				// assistant's prose starts after one blank line, as in Claude Code.
				if (hasReadableContentAfter) this.contentContainer.addChild(new Spacer(1));
				if (active) activeThinkingRunIndex = runIndex;
			} else if (content.type === "toolCall" && !groupedToolCallIds.has(content.id)) {
				// Tools without a thinking run are always standalone and visible.
				const tool = this.toolComponents.get(content.id);
				if (tool) this.contentContainer.addChild(tool);
			}
		}

		if (activeThinkingRunIndex === undefined) this.stopThinkingLoader();

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
