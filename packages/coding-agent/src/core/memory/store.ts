/**
 * Long-term memory store: typed records as plain markdown files with
 * frontmatter, three write channels (event hooks, model-initiated tool calls,
 * human edits) funneled through one ingestion pipeline, layered reads
 * (always-on profile, standing promises/anchors, on-demand recall), and a
 * consolidation pass that decays and archives stale episodes.
 *
 * File format is intentionally human-editable: every record is a standalone
 * .md file the user can read, edit, or delete by hand. Hand edits win — the
 * loader treats files on disk as ground truth and never overwrites them
 * without a write coming in.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { atomicWrite, withStorageLock } from "../storage.ts";
import { fitMemoryBudget, MEMORY_BUDGET } from "./budget.ts";

export const MEMORY_RECORD_TYPES = ["promise", "episode", "anchor", "whisper", "profile", "procedure"] as const;
export type MemoryRecordType = (typeof MEMORY_RECORD_TYPES)[number];

export type MemoryWriteSource = "hook" | "model" | "user";

export interface MemoryRecord {
	type: MemoryRecordType;
	title: string;
	body: string;
	salience: number;
	created: Date;
	updated: Date;
	tags: string[];
	status?: "open" | "fulfilled";
	archived?: boolean;
	/** File name inside the store root, set on load. */
	file?: string;
}

export interface MemoryWriteInput {
	type: MemoryRecordType;
	title: string;
	body: string;
	salience?: number;
	tags?: string[];
	status?: "open" | "fulfilled";
	/** Where the write came from; user commands bypass merge rejection. */
	source: MemoryWriteSource;
}

export interface MemoryWriteResult {
	action: "created" | "merged" | "rejected";
	file: string;
	note?: string;
}

export interface MemoryStats {
	totalRecords: number;
	byType: Partial<Record<MemoryRecordType, number>>;
	lastWrite: Date | null;
}

const DEFAULT_SALIENCE: Partial<Record<MemoryRecordType, number>> = {
	promise: 0.9,
	anchor: 1.0,
	whisper: 0.6,
	profile: 1.0,
	procedure: 0.7,
	episode: 0.5,
};

/** Episodes fade with a 30-day half-life; every other type is permanent. */
function decayFactor(record: MemoryRecord, now: Date): number {
	if (record.type !== "episode" || record.archived) return 1;
	const ageDays = Math.max(0, (now.getTime() - record.updated.getTime()) / 86_400_000);
	return 0.5 ** (ageDays / 30);
}

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.trim()
		.replace(/\s+/g, "-")
		.slice(0, 40);
	return slug || "record";
}

function parseDate(value: string | undefined): Date | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
	if (!raw.startsWith("---")) return { data: {}, body: raw };
	const end = raw.indexOf("\n---", 3);
	if (end === -1) return { data: {}, body: raw };
	const header = raw.slice(3, end);
	const body = raw.slice(raw.indexOf("\n", end + 1) + 1);
	const data: Record<string, string> = {};
	for (const line of header.split("\n")) {
		const sep = line.indexOf(":");
		if (sep === -1) continue;
		const key = line.slice(0, sep).trim();
		const value = line.slice(sep + 1).trim();
		if (key) data[key] = value;
	}
	return { data, body };
}

function serializeRecord(record: MemoryRecord): string {
	const lines = [
		"---",
		`type: ${record.type}`,
		`title: ${record.title.replace(/\n/g, " ")}`,
		`salience: ${record.salience}`,
		`created: ${record.created.toISOString()}`,
		`updated: ${record.updated.toISOString()}`,
	];
	if (record.tags.length > 0) lines.push(`tags: ${record.tags.join(",")}`);
	if (record.status) lines.push(`status: ${record.status}`);
	if (record.archived) lines.push(`archived: true`);
	lines.push("---", "", record.body.trimEnd(), "");
	return lines.join("\n");
}

export function defaultMemoryDir(): string {
	return join(getAgentDir(), "memory");
}

export class MemoryStore {
	private readonly root: string;
	private cache?: { records: MemoryRecord[]; loadedAt: number };

	constructor(root: string = defaultMemoryDir()) {
		this.root = root;
	}

	get dir(): string {
		return this.root;
	}

	/** Load all records; cached briefly so per-frame sidebar stats stay cheap. */
	list(force = false): MemoryRecord[] {
		const now = Date.now();
		if (!force && this.cache && now - this.cache.loadedAt < 5000) return this.cache.records;
		const records: MemoryRecord[] = [];
		if (existsSync(this.root)) {
			for (const name of readdirSync(this.root)) {
				if (!name.endsWith(".md")) continue;
				try {
					const raw = readFileSync(join(this.root, name), "utf-8");
					const { data, body } = parseFrontmatter(raw);
					const type = MEMORY_RECORD_TYPES.find((t) => t === data.type);
					if (!type || !data.title) continue;
					const created = parseDate(data.created) ?? new Date();
					records.push({
						type,
						title: data.title,
						body: body.trim(),
						salience: Number.isFinite(Number(data.salience))
							? Math.min(1, Math.max(0, Number(data.salience)))
							: (DEFAULT_SALIENCE[type] ?? 0.5),
						created,
						updated: parseDate(data.updated) ?? created,
						tags: data.tags
							? data.tags
									.split(",")
									.map((t) => t.trim())
									.filter(Boolean)
							: [],
						status: data.status === "open" || data.status === "fulfilled" ? data.status : undefined,
						archived: data.archived === "true",
						file: name,
					});
				} catch {
					// Unreadable file: skip rather than fail the whole store.
				}
			}
		}
		records.sort((a, b) => b.updated.getTime() - a.updated.getTime());
		this.cache = { records, loadedAt: now };
		return records;
	}

	/**
	 * The single ingestion pipeline. Duplicate titles replace the existing
	 * record; only explicit user commands are guaranteed to land (they may
	 * still merge, but are never dropped).
	 */
	write(input: MemoryWriteInput): MemoryWriteResult {
		return withStorageLock(join(this.root, "store"), () => this.writeLocked(input));
	}

	private writeLocked(input: MemoryWriteInput): MemoryWriteResult {
		input = { ...input, title: input.title.replace(/\s+/g, " ").trim() };
		if (input.title.length > 160) throw new Error("Memory title exceeds 160 characters");
		if (!input.title.trim() || !input.body.trim()) throw new Error("Memory title and body are required");
		if (Buffer.byteLength(input.body) > 16000)
			throw new Error("Memory exceeds 16000 UTF-8 bytes; summarize it first");
		mkdirSync(this.root, { recursive: true });
		const records = this.list(true);
		const existing = records.find((r) => r.type === input.type && r.title === input.title);

		if (existing?.file) {
			if (input.source === "hook" && existing.updated.getTime() > Date.now() - 60_000) {
				return { action: "rejected", file: existing.file, note: "recent duplicate" };
			}
			const merged: MemoryRecord = {
				...existing,
				body: input.body.trim(),
				salience: Math.max(existing.salience, input.salience ?? DEFAULT_SALIENCE[input.type] ?? 0.5),
				updated: new Date(),
				status: input.status ?? existing.status,
				tags: Array.from(new Set([...existing.tags, ...(input.tags ?? [])])),
			};
			atomicWrite(join(this.root, "history", `${randomUUID()}.md`), serializeRecord(existing));
			atomicWrite(join(this.root, existing.file), serializeRecord(merged));
			this.cache = undefined;
			return { action: "merged", file: existing.file };
		}

		const now = new Date();
		const record: MemoryRecord = {
			type: input.type,
			title: input.title,
			body: input.body,
			salience: input.salience ?? DEFAULT_SALIENCE[input.type] ?? 0.5,
			created: now,
			updated: now,
			tags: input.tags ?? [],
			status: input.status ?? (input.type === "promise" ? "open" : undefined),
		};
		const key = createHash("sha256").update(`${record.type}:${record.title}`).digest("hex").slice(0, 16);
		const file = `${slugify(record.title)}-${key}.md`;
		atomicWrite(join(this.root, file), serializeRecord(record));
		this.cache = undefined;
		return { action: "created", file };
	}

	/** Mark a promise fulfilled; keeps the record and its history. */
	fulfill(title: string): MemoryWriteResult {
		const record = this.list(true).find((r) => r.type === "promise" && r.title === title);
		if (!record?.file) return { action: "rejected", file: "", note: "no such promise" };
		return this.write({ ...record, status: "fulfilled", source: "user" });
	}

	/** Relevance × salience × decay scoring over title, body, and tags. */
	recall(query: string, limit = 5): Array<{ record: MemoryRecord; score: number }> {
		const terms = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(query.toLowerCase())]
			.filter((part) => part.isWordLike)
			.map((part) => part.segment);
		if (terms.length === 0) return [];
		const now = new Date();
		const scored: Array<{ record: MemoryRecord; score: number }> = [];
		const active = this.list(true);
		const keys = new Set(active.map((record) => `${record.type}:${record.title}`));
		const archived = new MemoryStore(join(this.root, "archive"))
			.list(true)
			.filter((record) => !keys.has(`${record.type}:${record.title}`));
		for (const record of [...active, ...archived]) {
			const haystack = `${record.title} ${record.body} ${record.tags.join(" ")}`.toLowerCase();
			const hits = terms.filter((t) => haystack.includes(t)).length;
			if (hits === 0) continue;
			let score = (hits / terms.length) * record.salience * decayFactor(record, now);
			if (record.type === "promise" && record.status === "open") score *= 2;
			scored.push({ record, score });
		}
		return scored.sort((a, b) => b.score - a.score).slice(0, Math.min(20, Math.max(0, Math.floor(limit))));
	}

	/**
	 * Consolidation: episodes that decayed below the floor are archived in
	 * full, preserving their content for later inspection.
	 * Returns how many records were archived.
	 */
	consolidate(): number {
		return withStorageLock(join(this.root, "store"), () => this.consolidateLocked());
	}

	private consolidateLocked(): number {
		const now = new Date();
		const archiveDir = join(this.root, "archive");
		let archived = 0;
		const records = this.list(true);
		for (const [index, record] of records.entries()) {
			if (index >= 200 || (record.type === "episode" && decayFactor(record, now) < 0.2)) {
				if (!record.file) continue;
				mkdirSync(archiveDir, { recursive: true });
				atomicWrite(
					join(
						archiveDir,
						existsSync(join(archiveDir, record.file)) ? `${randomUUID()}-${record.file}` : record.file,
					),
					serializeRecord({ ...record, archived: true }),
				);
				unlinkSync(join(this.root, record.file));
				archived++;
			}
		}
		if (archived > 0) this.cache = undefined;
		return archived;
	}

	/** Always-injected context: profile in full, standing promises/anchors as lines. */
	buildStandingContext(budgetChars: number = MEMORY_BUDGET.standing): string {
		const records = this.list(true);
		const sections: string[] = [];
		const profiles = records.filter((r) => r.type === "profile" && !r.archived);
		if (profiles.length > 0) {
			const body = profiles
				.map((p) => p.body)
				.join("\n\n")
				.slice(0, budgetChars / 2);
			sections.push(`### Profile\n${body}`);
		}
		const standing = records.filter(
			(r) => (r.type === "promise" || r.type === "anchor" || r.type === "procedure") && !r.archived,
		);
		if (standing.length > 0) {
			const lines = standing.slice(0, 20).map((r) => {
				const flag =
					r.type === "promise" && r.status === "open" ? " (open)" : r.status === "fulfilled" ? " (fulfilled)" : "";
				return `- ${r.title}${flag}`;
			});
			sections.push(`### Standing\n${lines.join("\n")}`);
		}
		if (sections.length === 0) return "";
		const header = "## Long-term memory\nUse memory_recall to search older episodes by topic.";
		return fitMemoryBudget([header, ...sections].join("\n\n"), Math.min(budgetChars, MEMORY_BUDGET.standing));
	}

	stats(): MemoryStats {
		const records = this.list(true);
		const byType: Partial<Record<MemoryRecordType, number>> = {};
		let lastWrite: Date | null = null;
		for (const record of records) {
			byType[record.type] = (byType[record.type] ?? 0) + 1;
			if (!lastWrite || record.updated > lastWrite) lastWrite = record.updated;
		}
		return { totalRecords: records.length, byType, lastWrite };
	}
}

const stores = new Map<string, MemoryStore>();

export function getMemoryStore(): MemoryStore {
	const root = defaultMemoryDir();
	let store = stores.get(root);
	if (!store) {
		store = new MemoryStore(root);
		stores.set(root, store);
	}
	return store;
}
