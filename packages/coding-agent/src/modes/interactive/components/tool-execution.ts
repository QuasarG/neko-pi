import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderers } from "../../../core/extensions/types.ts";

/** What this component needs from a tool: how to draw it, without executing it. */
export type { ToolRenderers };

import { formatToolCallWithArgs, getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { ensurePngTranscoder } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

const FALLBACK_PREVIEW_LINES = 10;

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	outputPad?: number;
	/** Indent level for nested calls (parentToolCallId chain depth). */
	indent?: number;
}

export class ToolExecutionComponent extends Container {
	/**
	 * Class-wide compact mode: finished tool calls render as a one-line summary
	 * until expanded (click or ctrl+o). Disabled for verbose sessions.
	 */
	static compactMode = true;

	private static readonly SUMMARY_ARG_KEYS = [
		"file_path",
		"path",
		"command",
		"cmd",
		"pattern",
		"query",
		"url",
		"name",
		"description",
		"title",
	];

	private contentBox: Box;
	private contentText: Text;
	private contentTextRegion: MouseRegion;
	private selfRenderContainer: Container;
	private selfRenderHeight = 0;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	/** Inputs of imageComponents, so updateDisplay can reuse images and keep their converted PNG data. */
	private imageSources: Array<{ data: string; mimeType: string; widthCells: number }> = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;

	/** The tool's name, for visibility rules in parent components. */
	get name(): string {
		return this.toolName;
	}
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private outputPad: number;
	private isPartial = true;
	private toolDefinition?: ToolRenderers;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
		durationMs?: number;
	};
	private hideComponent = false;
	private readonly indent: number;
	private compactText: Text;
	private compactRegion: MouseRegion;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolRenderers | ToolDefinition<any, any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.outputPad = options.outputPad ?? 1;
		this.indent = options.indent ?? 0;

		this.compactText = new Text("", this.outputPad + this.indent * 2, 0);
		this.compactRegion = new MouseRegion(this.compactText, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(true);
			return { handled: true };
		});
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentTextRegion = this.createResultRegion(this.contentText);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentTextRegion);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		return this.toolDefinition?.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		return this.toolDefinition?.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		return this.toolDefinition?.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
			durationMs: this.isPartial ? undefined : this.result?.durationMs,
			outputPad: this.outputPad,
		};
	}

	private createCallFallback(): Component {
		return new Text(formatToolCallWithArgs(this.toolName, this.args, theme, this.expanded), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}

		const lines = output.split("\n");
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	}

	private createResultRegion(component: Component): MouseRegion {
		return new MouseRegion(component, (event) => {
			if (!this.result || event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			return { handled: true };
		});
	}

	getIndent(): number {
		return this.indent;
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
			/** Execution time of a final result. */
			durationMs?: number;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	getToolCallId(): string {
		return this.toolCallId;
	}

	/** Failed calls stay visible even when their label names them. */
	hasFailedResult(): boolean {
		return this.result?.isError === true;
	}

	/** Running tools remain visible until their final result arrives. */
	hasSettledResult(): boolean {
		return this.result !== undefined && !this.isPartial;
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}

		// Compact summary only for finished calls; a running tool with partial
		// output must keep streaming visibly (regression #8611).
		if (this.isCompact() && !(this.isPartial && this.result !== undefined)) {
			return this.renderCompactLine(width);
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			this.selfRenderHeight = contentLines.length;
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			const lines: string[] = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...contentLines);
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					lines.push(...imageComponent.render(width));
				}
			}
			return lines;
		}

		return super.render(width);
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		// Compact mode renders compactRegion's output, but compactRegion is not
		// a child of this Container — route mouse events to it directly.
		if (this.isCompact() && !(this.isPartial && this.result !== undefined)) {
			const result = this.compactRegion.handleMouse(event);
			// The callback's side effect (setExpanded) is what matters here; the
			// parent only needs to know the event was consumed.
			return result ? ({ handled: true } as ReturnType<Container["handleMouse"]>) : undefined;
		}
		if (!this.hasRendererDefinition() || this.getRenderShell() !== "self") return super.handleMouse(event);
		if (event.y <= 0 || event.y > this.selfRenderHeight) return undefined;
		return this.selfRenderContainer.handleMouse({
			...event,
			y: event.y - 1,
			height: this.selfRenderHeight,
		});
	}

	private isCompact(): boolean {
		return !this.expanded && ToolExecutionComponent.compactMode && this.toolDefinition?.renderCompact !== false;
	}

	private summarizeArgs(): string {
		if (this.args === null || typeof this.args !== "object") {
			return typeof this.args === "string" ? this.args : "";
		}
		const record = this.args as Record<string, unknown>;
		let picked: string | undefined;
		for (const key of ToolExecutionComponent.SUMMARY_ARG_KEYS) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) {
				picked = value.trim();
				break;
			}
		}
		if (picked === undefined) {
			for (const value of Object.values(record)) {
				if (typeof value === "string" && value.trim()) {
					picked = value.trim();
					break;
				}
			}
		}
		if (!picked) return "";
		if (picked.startsWith(`${this.cwd}/`)) {
			const rel = picked.slice(this.cwd.length + 1);
			if (rel) picked = rel;
		}
		return picked;
	}

	private renderCompactLine(width: number): string[] {
		const status = this.isPartial
			? this.executionStarted
				? "运行中"
				: "准备中"
			: this.result?.isError
				? "失败"
				: "完成";
		const statusColor = this.isPartial ? "warning" : this.result?.isError ? "error" : "success";
		const prefix = `${theme.fg(statusColor, status)} ${theme.bold(theme.fg("accent", this.toolName))}`;
		const separator = theme.fg("dim", " · ");
		const tails: string[] = [];
		if (!this.isPartial && this.result?.durationMs !== undefined) {
			const seconds = this.result.durationMs / 1000;
			tails.push(`耗时 ${seconds < 60 ? seconds.toFixed(1) : Math.round(seconds)}s`);
		}
		const output = this.getTextOutput().trimEnd();
		if (!this.isPartial && output) tails.push(`输出 ${output.split("\n").length} 行`);
		const tail = tails.length > 0 ? separator + theme.fg("muted", tails.join(" · ")) : "";
		const available = Math.max(0, width - (this.outputPad + this.indent * 2) * 2);
		const summaryWidth = available - visibleWidth(prefix) - visibleWidth(tail) - 3;
		const summary =
			summaryWidth > 1 ? truncateToWidth(this.summarizeArgs().replace(/\s+/g, " "), summaryWidth, "…") : "";
		const line = prefix + (summary ? separator + theme.fg("text", summary) : "") + tail;
		this.compactText.setText(truncateToWidth(line, available, "…"));
		const lines = this.compactRegion.render(width);
		if (this.result?.isError && output) {
			lines.push(
				...new Text(
					theme.fg("error", truncateToWidth(output.split("\n")[0], available, "…")),
					this.outputPad + this.indent * 2,
					0,
				).render(width),
			);
		}
		for (const image of this.imageComponents) lines.push(...image.render(width));
		return lines;
	}

	private updateDisplay(): void {
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
				renderContainer.setPaddingX(this.outputPad);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(this.createResultRegion(component));
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(this.createResultRegion(component));
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(this.createResultRegion(component));
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(this.createResultRegion(component));
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setPaddingX(this.outputPad);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		const previousImages = this.imageComponents;
		const previousSources = this.imageSources;
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		this.imageSources = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (const img of imageBlocks) {
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const source = { data: img.data, mimeType: img.mimeType, widthCells: this.imageWidthCells };
					const index = this.imageComponents.length;
					const previous = previousSources[index];
					const imageComponent =
						previous?.data === source.data &&
						previous.mimeType === source.mimeType &&
						previous.widthCells === source.widthCells
							? previousImages[index]
							: new Image(
									source.data,
									source.mimeType,
									{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
									{ maxWidthCells: source.widthCells },
								);
					if (source.mimeType !== "image/png") {
						ensurePngTranscoder(() => {
							this.invalidate();
							this.ui.requestRender();
						});
					}
					this.imageComponents.push(imageComponent);
					this.imageSources.push(source);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
