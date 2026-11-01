import { Container, Markdown, type MarkdownTheme, Spacer } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { InjectedContextParts } from "../../../core/injected-context.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { InjectedContextComponent } from "./injected-context-message.ts";
import { createMarkdownTransform, glyphPrefixedMarkdown, USER_GLYPH } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private messageId?: string;
	private timestamp?: string;
	private injectedContext?: InjectedContextComponent;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.injectedContext?.setOutputPad(padding + 2);
		this.rebuild();
	}

	setInjectedContext(parts: InjectedContextParts, expanded: boolean): void {
		this.injectedContext = new InjectedContextComponent(parts, this.markdownTheme, this.outputPad + 2);
		this.injectedContext.setExpanded(expanded);
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		this.injectedContext?.setExpanded(expanded);
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		// The Markdown pads and colors its own text: a Box around it would keep a second full-width copy of every
		// line, with identical output. No background block - Claude Code marks the user's line with a glyph.
		this.addChild(
			new Markdown(
				this.text,
				this.outputPad,
				0,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
				},
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: (markdown, availableWidth) => {
						const transformed = createMarkdownTransform(
							"user",
							false,
							this.markdownTransformers,
							this.messageId,
							this.timestamp,
						)(markdown, availableWidth);
						// Claude Code style: what the user typed is marked with ❯.
						return glyphPrefixedMarkdown(transformed, USER_GLYPH).text;
					},
				},
			),
		);
		if (this.injectedContext) this.addChild(this.injectedContext);
		this.addChild(new Spacer(1));
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
