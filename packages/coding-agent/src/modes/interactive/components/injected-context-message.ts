import { Box, Container, Markdown, type MarkdownTheme, MouseRegion, Text } from "@earendil-works/pi-tui";
import {
	type InjectedContextParts,
	parseInjectedContext,
	producerOf,
	producerSummaries,
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
		// No background and no extra vertical padding: system rows sit directly
		// under the user's line, while the full blocks stay one click away.
		super(outputPad, 0);
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
		if (this.expanded) {
			content.addChild(new Text(theme.fg("customMessageLabel", "▾ 注入上下文"), 0, 0));
			// dsh form attribute: each block opens under its producer's title.
			let lastProducer = "";
			for (const block of this.parts.blocks) {
				const producer = producerOf(block.tag);
				if (producer !== lastProducer) {
					content.addChild(new Text(theme.fg("dim", `— ${producer} —`), 0, 0));
					lastProducer = producer;
				}
				content.addChild(
					new Markdown(`**<${block.tag}>**\n\n${block.body}`, 0, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("customMessageText", text),
					}),
				);
			}
		} else {
			// dsh role+producer rows: one line per producing extension.
			const rows = producerSummaries(this.parts);
			for (const row of rows) {
				const last = row === rows[rows.length - 1];
				content.addChild(
					new Text(
						theme.fg("customMessageLabel", `${row === rows[0] ? "▸ 注入 ·" : "       ·"} ${row.producer} `) +
							theme.fg("customMessageText", row.facts.join(" · ")) +
							theme.fg(
								"dim",
								last
									? ` · 点击展开${keyText("app.tools.expand") ? ` / ${keyText("app.tools.expand")}` : ""}`
									: "",
							),
						0,
						0,
					),
				);
			}
			if (rows.length === 0) {
				content.addChild(
					new Text(theme.fg("customMessageLabel", "▸ 注入上下文 ") + theme.fg("dim", "· 点击展开"), 0, 0),
				);
			}
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
