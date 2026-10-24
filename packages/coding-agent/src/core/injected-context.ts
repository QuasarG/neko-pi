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

/** Which extension produced an injection block (dsh producer attribute). */
export function producerOf(tag: string): "runtime-context" | "memory" {
	return tag === "runtime_memory" ? "memory" : "runtime-context";
}

export interface ProducerSummary {
	producer: "runtime-context" | "memory";
	/** One-line facts this producer delivered beyond the raw text. */
	facts: string[];
}

/** Split the one-line summary into per-producer rows (dsh role+producer rows). */
export function producerSummaries(parts: InjectedContextParts): ProducerSummary[] {
	const block = (tag: string) => parts.blocks.find((b) => b.tag === tag)?.body ?? "";
	const rows: ProducerSummary[] = [];

	const contextFacts: string[] = [];
	const time = block("message_time");
	if (time) {
		const wall = time.match(/\(([^)]*,\s*[^)]*)\)\s*$/)?.[1];
		contextFacts.push(`时间 ${wall ?? time.slice(0, 32)}`);
	}
	const activity = block("runtime_activity");
	if (activity) contextFacts.push(`活动 ${(activity.match(/^- /gm) ?? []).length}`);
	const outfit = activity.match(/^outfit: (.+)$/m)?.[1];
	if (outfit) contextFacts.push(`穿着 ${outfit.slice(0, 24)}`);
	if (contextFacts.length > 0) rows.push({ producer: "runtime-context", facts: contextFacts });

	const memoryFacts: string[] = [];
	const memory = block("runtime_memory");
	if (memory) {
		for (const m of memory.matchAll(/### Memory: (\S+) \(v(\d+), (\d+)\/(\d+) records\)/g))
			memoryFacts.push(`${m[1]} v${m[2]} (${m[3]}本)`);
		const continuity = [...memory.matchAll(/Recent shared continuity/g)].length;
		if (continuity > 0) memoryFacts.push(`便签×${continuity}`);
	}
	if (memoryFacts.length > 0) rows.push({ producer: "memory", facts: memoryFacts });

	return rows;
}
