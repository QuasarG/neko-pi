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

const INJECTION_TAGS = [
	"message_time",
	"runtime_activity",
	"runtime_memory",
	"checkpoint",
	"memory_hint",
	"runtime_compensation",
	"runtime_continuity",
	"wardrobe_error",
	"model_error",
] as const;

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
	return tag === "runtime_memory" || tag === "memory_hint" ? "memory" : "runtime-context";
}

export interface ProducerSummary {
	producer: "runtime-context" | "memory";
	/** One-line facts this producer delivered beyond the raw text. */
	facts: string[];
}

/** A record block parsed from a `### Memory baseline/update: <scope>` section. */
export interface MemoryDeliveryRecord {
	/** Scope label from the section heading, e.g. `persona` or `project bed947e0`. */
	scopeLabel: string;
	/** `- record:` title line. */
	title: string;
	/** `- version:` line, or the `· version: N` field inside `- type:`. */
	version: number;
	/** `- file:` path line. */
	file: string;
}

export interface MemoryDelivery {
	/** Which section kind the body carries; baseline wins when both appear. */
	kind: "baseline" | "update";
	records: MemoryDeliveryRecord[];
	/** Tombstones counted from `- record_id:` lines in removed sections. */
	removed: number;
	/** Continuity labels seen (`Recent project/shared continuity`). */
	continuity: number;
	/** Budget omission notices seen (`more records exceeded` / `omitted`). */
	omitted: number;
}

/**
 * Parse the Markdown wire body inside <runtime_memory>. Tolerant by design:
 * unknown lines are ignored, missing metadata yields defaults, never throws.
 * Legacy `### Memory: <scope> (vN, n/m records)` snapshots produce no records
 * here and stay on the legacy summary path in producerSummaries.
 */
export function parseMemoryDelivery(body: string): MemoryDelivery {
	let kind: "baseline" | "update" = "update";
	const records: MemoryDeliveryRecord[] = [];
	let removed = 0;
	let continuity = 0;
	let omitted = 0;

	let scopeLabel = "";
	let pending: MemoryDeliveryRecord | null = null;
	// True while the contiguous `- record:` header block is open: once a blank
	// or body line appears, "- version:"-like lines in the body (record prose
	// or diff lines) must not overwrite the header fields.
	let headersOpen = false;
	const flush = () => {
		if (pending?.scopeLabel) records.push(pending);
		pending = null;
		headersOpen = false;
	};

	for (const line of body.split("\n")) {
		// Structural prefixes first: a record title may itself contain the
		// keywords ("omitted", continuity phrases) and must never be swallowed
		// by the substring scans further down.
		const heading = line.match(/^### Memory (baseline|update|removed): (.*)$/);
		if (heading) {
			flush();
			if (heading[1] === "baseline") kind = "baseline";
			scopeLabel = heading[2]!.trim();
			continue;
		}
		if (line.startsWith("- record_id:")) {
			removed++;
			continue;
		}
		const record = line.match(/^- record:\s*(.*)$/);
		if (record) {
			flush();
			pending = { scopeLabel, title: record[1]!.trim(), version: 0, file: "" };
			headersOpen = true;
			continue;
		}
		if (pending) {
			if (!line.startsWith("- ")) headersOpen = false;
			else if (headersOpen) {
				// Version is anchored to metadata lines only (standalone or inside
				// `- type:`) so body prose like "version: 7" cannot overwrite it.
				const version = line.match(/^- version:\s*(\d+)/) ?? line.match(/^- type:.*\bversion:\s*(\d+)/);
				if (version) pending.version = Number(version[1]);
				const file = line.match(/^- file:\s*(.*)$/);
				if (file) pending.file = file[1]!.trim();
			}
		}
		// Continuity labels and omission notices are plain text lines; metadata
		// and diff lines all start with "- " or "+ ", so those prefixes never
		// feed these counters.
		if (!line.startsWith("- ") && !line.startsWith("+ ")) {
			if (line.includes("Recent project continuity") || line.includes("Recent shared continuity")) {
				continuity++;
				continue;
			}
			if (line.includes("more records exceeded") || line.includes("omitted")) {
				// `N more records exceeded` carries the dropped-record count;
				// other omission notices have no number and count as one each.
				omitted += Number(line.match(/(\d+) more records exceeded/)?.[1] ?? 1);
			}
		}
	}
	flush();
	return { kind, records, removed, continuity, omitted };
}

/**
 * The outfit rides inside <runtime_activity> as a single-line JSON payload
 * (the legacy `^outfit:` line format never shipped, so a line regex can never
 * match). Scan lines that look like the JSON body and extract outfit.name;
 * anything unparsable stays quiet.
 */
function outfitNameOf(body: string): string | undefined {
	for (const line of body.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line) as { outfit?: { name?: unknown } };
			const name = parsed.outfit?.name;
			if (typeof name === "string" && name) return name;
		} catch {
			// Not the JSON payload line; keep scanning.
		}
	}
	return undefined;
}

/** Split the one-line summary into per-producer rows (dsh role+producer rows). */
export function producerSummaries(parts: InjectedContextParts): ProducerSummary[] {
	const block = (tag: string) => parts.blocks.find((b) => b.tag === tag)?.body ?? "";
	const rows: ProducerSummary[] = [];

	const contextFacts: string[] = [];
	const time = block("message_time");
	if (time) {
		const wall = time.match(/\(([^)]*,\s*[^)]*)\)\s*$/)?.[1];
		// The collapsed row stays quiet: day/month + HH:mm is enough here; the
		// expanded block keeps the full timestamp and timezone for auditing.
		const compact = wall?.match(/(\d{2}\/\d{2})\/\d{4},\s*(\d{2}:\d{2})/);
		contextFacts.push(compact ? `${compact[1]} ${compact[2]}` : (wall ?? time.slice(0, 32)));
	}
	const activity = block("runtime_activity");
	if (activity) contextFacts.push(`活动 ${(activity.match(/^- /gm) ?? []).length}`);
	const outfit = outfitNameOf(activity);
	if (outfit) contextFacts.push(`穿着 ${outfit.slice(0, 24)}`);
	const checkpoint = block("checkpoint");
	if (checkpoint) contextFacts.push(`检查点 ${(checkpoint.match(/continuity|memory/g) ?? []).join("·")}`);
	if (contextFacts.length > 0) rows.push({ producer: "runtime-context", facts: contextFacts });

	const memoryFacts: string[] = [];
	const memory = block("runtime_memory");
	if (memory) {
		if (/^### Memory (?:baseline|update|removed):/m.test(memory)) {
			const delivery = parseMemoryDelivery(memory);
			// Collapse records per scope: the heading label's first token is the
			// scope name (`project bed947e0` collapses to `project`).
			const counts = new Map<string, number>();
			for (const record of delivery.records) {
				const scope = record.scopeLabel.split(/\s+/)[0]!;
				counts.set(scope, (counts.get(scope) ?? 0) + 1);
			}
			if (counts.size > 0) {
				const scopeText = [...counts].map(([scope, n]) => `${scope} ${n}本`).join(" · ");
				memoryFacts.push(`${delivery.kind} ${scopeText}`);
			}
			if (delivery.removed > 0) memoryFacts.push(`removed ×${delivery.removed}`);
			const projectC = (memory.match(/Recent project continuity/g) ?? []).length;
			const sharedC = (memory.match(/Recent shared continuity/g) ?? []).length;
			if (projectC > 0) memoryFacts.push(`便签 project ×${projectC}`);
			if (sharedC > 0) memoryFacts.push(`便签 persona ×${sharedC}`);
			if (delivery.omitted > 0) memoryFacts.push(`omitted ×${delivery.omitted}`);
		} else {
			for (const m of memory.matchAll(/### Memory: (\S+) \(v(\d+), (\d+)\/(\d+) records\)/g))
				memoryFacts.push(`${m[1]} v${m[2]} (${m[3]}本)`);
			const continuity = [...memory.matchAll(/Recent shared continuity/g)].length;
			if (continuity > 0) memoryFacts.push(`便签×${continuity}`);
		}
	}
	// The imperative-cue hint rides in its own block; one collapsed fact.
	if (block("memory_hint")) memoryFacts.push("提示");
	if (memoryFacts.length > 0) rows.push({ producer: "memory", facts: memoryFacts });

	return rows;
}
