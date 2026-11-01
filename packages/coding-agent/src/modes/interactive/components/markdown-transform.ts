import type { MarkdownTransformContext, MarkdownTransformer } from "../../../core/extensions/types.ts";

/** Glyph Claude Code puts in front of a model reply. */
export const ASSISTANT_GLYPH = "⏺";
/** Glyph Claude Code puts in front of what the user typed. */
export const USER_GLYPH = "❯";

const BLOCK_START = /^(```|~~~|#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|\|)/;

/**
 * Claude Code leads a message with a glyph that shares the first line with
 * the text. Block constructs (code fences, headings, lists) own their layout,
 * so they keep the glyph off the text.
 */
export function glyphPrefixedMarkdown(markdown: string, glyph: string): { text: string; inline: boolean } {
	const trimmed = markdown.trim();
	if (!trimmed) {
		return { text: markdown, inline: false };
	}
	const firstLine = trimmed.split("\n", 1)[0] ?? "";
	if (BLOCK_START.test(firstLine)) {
		return { text: markdown, inline: false };
	}
	return { text: `${glyph} ${trimmed}`, inline: true };
}

export function createMarkdownTransform(
	messageType: MarkdownTransformContext["messageType"],
	isStreaming: boolean,
	transformers: readonly MarkdownTransformer[],
	messageId?: string,
	timestamp?: string,
): (markdown: string, availableWidth: number) => string {
	return (markdown, availableWidth) =>
		applyMarkdownTransformers(
			markdown,
			{ messageType, isStreaming, availableWidth, messageId, timestamp },
			transformers,
		);
}

function applyMarkdownTransformers(
	markdown: string,
	context: MarkdownTransformContext,
	transformers: readonly MarkdownTransformer[],
): string {
	let transformedMarkdown = markdown;
	for (const transformer of transformers) {
		try {
			const transformed = transformer(transformedMarkdown, context);
			if (typeof transformed === "string") {
				transformedMarkdown = transformed;
			}
		} catch {
			// Keep the current Markdown and continue with the next transformer.
		}
	}
	return transformedMarkdown;
}
