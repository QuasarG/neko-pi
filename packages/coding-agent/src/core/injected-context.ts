/**
 * Split a user message into what the human typed and the context blocks the
 * harness appended for delivery (<message_time>, <runtime_activity>,
 * <runtime_memory>, attachments). The transcript stores the full delivered
 * text; the UI must show the human part as the bubble and the harness part
 * as a collapsible marker, so injected context is visible without noise.
 */

export interface InjectedContextParts {
	/** The human-authored text (empty when the message is harness-only). */
	userText: string;
	/** Ordered trailing injection blocks: tag name and full body. */
	blocks: Array<{ tag: string; body: string }>;
}

const INJECTION_TAGS = ["message_time", "runtime_activity", "runtime_memory"] as const;

/** Parse trailing injection blocks; returns null when the text has none. */
export function parseInjectedContext(text: string): InjectedContextParts | null {
	const blocks: Array<{ tag: string; body: string }> = [];
	let rest = text.replace(/\s+$/, "");
	let matched = true;
	while (matched) {
		matched = false;
		for (const tag of INJECTION_TAGS) {
			// Blocks are separated by a blank line; allow any spacing around
			// the tags so multi-newline separators still strip cleanly.
			const pattern = new RegExp(`\\s*<${tag}>\\n?([\\s\\S]*?)\\s*</${tag}>$`);
			const hit = rest.match(pattern);
			if (hit) {
				blocks.unshift({ tag, body: hit[1]!.trim() });
				rest = rest.slice(0, rest.length - hit[0].length).replace(/\s+$/, "");
				matched = true;
				break;
			}
		}
	}
	if (blocks.length === 0) return null;
	return { userText: rest.trim(), blocks };
}

/** One-line summary in the ◈ marker style: what was delivered beyond the text. */
export function summarizeInjectedContext(parts: InjectedContextParts): string {
	const bits: string[] = [];
	const block = (tag: string) => parts.blocks.find((b) => b.tag === tag)?.body ?? "";
	const time = block("message_time");
	if (time) {
		// Wall clock rides in parentheses in the delivered block; prefer it over
		// the UTC ISO stamp so the summary matches what the user lived.
		const wall = time.match(/\(([^)]*,\s*[^)]*)\)\s*$/)?.[1];
		bits.push(`time ${wall ?? time.slice(0, 32)}`);
	}
	const activity = block("runtime_activity");
	if (activity) {
		const events = (activity.match(/^- /gm) ?? []).length;
		bits.push(`activity ${events}`);
	}
	const memory = block("runtime_memory");
	if (memory) {
		const versions = [...memory.matchAll(/### Memory: (\S+) \(v(\d+)/g)].map((m) => `${m[1]} v${m[2]}`);
		if (versions.length > 0) bits.push(`memory ${versions.join(" ")}`);
		const continuity = [...memory.matchAll(/Recent shared continuity/g)].length;
		if (continuity > 0) bits.push(`continuity ×${continuity}`);
	}
	return bits.join(" · ");
}
