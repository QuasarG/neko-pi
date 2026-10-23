import { Box, Container, Markdown, type MarkdownTheme, MouseRegion, Text } from "@earendil-works/pi-tui";
import {
	type InjectedContextParts,
	parseInjectedContext,
	summarizeInjectedContext,
} from "../../../core/injected-context.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Collapsible marker for the context the harness delivered with a user
 * message (time, activity, memory). The transcript stores the full text;
 * this keeps the chat readable while the injection stays auditable —
 * one ◈ line collapsed, full blocks expanded.
 */
export class InjectedContextComponent extends Box {
	private expanded = false;
	private parts: InjectedContextParts;
	private markdownTheme: MarkdownTheme;

	constructor(parts: InjectedContextParts, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		this.parts = parts;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.setPaddingX(outputPad);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const content = new Container();
		const summary = summarizeInjectedContext(this.parts);
		if (this.expanded) {
			content.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m◈ injected\x1b[22m`), 0, 0));
			for (const block of this.parts.blocks) {
				content.addChild(
					new Markdown(`**<${block.tag}>**\n\n${block.body}`, 0, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("customMessageText", text),
					}),
				);
			}
		} else {
			content.addChild(
				new Text(
					theme.fg("customMessageLabel", `\x1b[1m◈ injected\x1b[22m `) +
						theme.fg("customMessageText", summary || `${this.parts.blocks.length} blocks`) +
						theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`),
					0,
					0,
				),
			);
		}
		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}

/** Render helper: returns the marker when the text carries injections. */
export function parseInjections(text: string): InjectedContextParts | null {
	return parseInjectedContext(text);
}
