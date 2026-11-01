/**
 * Long-term memory store: typed records as plain markdown files with
 * frontmatter, one records directory per scope (persona or one project),
 * stable record IDs that survive file renames, and a consolidation pass
 * that archives stale episodes losslessly.
 *
 * File format is intentionally human-editable: every record is a standalone
 * .md file the user can read, edit, or delete by hand. Hand edits win — the
 * loader treats files on disk as ground truth; the runtime database only
 * mirrors metadata and detects external changes.
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
	/** Stable record ID, allocated once and kept across renames. */
	id?: string;
	type: MemoryRecordType;
	title: string;
	body: string;
	salience: number;
	created: Date;
	updated: Date;
	/** In-memory only: true when frontmatter carried a parseable `created`,
	 *  false when the new Date() fallback fired. Never serialized. */
	createdKnown?: boolean;
	tags: string[];
	status?: "open" | "fulfilled";
	archived?: boolean;
	/** Optimistic concurrency version, bumped on every persisted write. */
	version?: number;
	/** File name inside the store root, set on load. */
	file?: string;
	/** Scratch provenance: the session and cwd that created an unassigned record. */
	originSessionId?: string;
	originCwd?: string;
	/** Explicit target project for a future promotion, when the user named one. */
	targetProjectId?: string;
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
	originSessionId?: string;
	originCwd?: string;
	targetProjectId?: string;
}

export interface MemoryWriteResult {
	action: "created" | "merged" | "rejected" | "conflict";
	file: string;
	note?: string;
	recordId?: string;
	version?: number;
	/** The superseded record on a merge, for UI diffs. */
	previous?: { version: number; body: string; file: string };
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

export function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.trim()
		.replace(/\s+/g, "-")
		.slice(0, 40);
	return slug || "record";
}

/** Stable id for a topic; exported for the channel's legacy-file fallback. */
export function stableRecordId(type: string, title: string): string {
	return `rec_${createHash("sha256").update(`${type}:${title}`).digest("hex").slice(0, 12)}`;
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
		`id: ${record.id ?? stableRecordId(record.type, record.title)}`,
		`type: ${record.type}`,
		`title: ${record.title.replace(/\n/g, " ")}`,
		`salience: ${record.salience}`,
		`created: ${record.created.toISOString()}`,
		`updated: ${record.updated.toISOString()}`,
		`version: ${record.version ?? 1}`,
	];
	if (record.tags.length > 0) lines.push(`tags: ${record.tags.join(",")}`);
	if (record.status) lines.push(`status: ${record.status}`);
	if (record.archived) lines.push(`archived: true`);
	if (record.originSessionId) lines.push(`origin_session: ${record.originSessionId}`);
	if (record.originCwd) lines.push(`origin_cwd: ${record.originCwd}`);
	if (record.targetProjectId) lines.push(`target_project: ${record.targetProjectId}`);
	lines.push("---", "", record.body.trimEnd(), "");
	return lines.join("\n");
}

/** Canonical markdown bytes for a record; identical to what persist() writes. */
export function serializeMemoryRecord(record: MemoryRecord): string {
	return serializeRecord(record);
}

/** Canonical file name for a record, so callers can journal the real target. */
export function memoryRecordFileName(record: MemoryRecord): string {
	const id = record.id ?? stableRecordId(record.type, record.title);
	return `${record.type}-${slugify(record.title)}--${id.replace("rec_", "")}.md`;
}

export function defaultMemoryDir(): string {
	return join(getAgentDir(), "memory", "persona");
}

/** The root that holds `persona/` and `projects/` scope directories. */
export function memoryRootDir(): string {
	return join(getAgentDir(), "memory");
}

export function readRecordFile(file: string): MemoryRecord | undefined {
	const raw = readFileSync(file, "utf-8");
	const { data, body } = parseFrontmatter(raw);
	const type = MEMORY_RECORD_TYPES.find((t) => t === data.type);
	if (!type || !data.title) return undefined;
	const parsedCreated = parseDate(data.created);
	const created = parsedCreated ?? new Date();
	return {
		id: data.id,
		type,
		title: data.title,
		body: body.trim(),
		salience: Number.isFinite(Number(data.salience))
			? Math.min(1, Math.max(0, Number(data.salience)))
			: (DEFAULT_SALIENCE[type] ?? 0.5),
		created,
		createdKnown: parsedCreated !== undefined,
		updated: parseDate(data.updated) ?? created,
		tags: data.tags
			? data.tags
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: [],
		status: data.status === "open" || data.status === "fulfilled" ? data.status : undefined,
		archived: data.archived === "true",
		version: Number.isFinite(Number(data.version)) ? Number(data.version) : 1,
		originSessionId: data.origin_session || undefined,
		originCwd: data.origin_cwd || undefined,
		targetProjectId: data.target_project || undefined,
	};
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

	/** Load all records; cached briefly so repeated reads stay cheap. */
	list(force = false): MemoryRecord[] {
		const now = Date.now();
		if (!force && this.cache && now - this.cache.loadedAt < 5000) return this.cache.records;
		const records: MemoryRecord[] = [];
		if (existsSync(this.root)) {
			for (const name of readdirSync(this.root)) {
				if (!name.endsWith(".md")) continue;
				try {
					const record = readRecordFile(join(this.root, name));
					if (record) records.push({ ...record, file: name });
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
	 * Resolve a write into the record it would produce: a merge into an
	 * existing topic or a brand-new record. Pure — no file is touched.
	 */
	prepareWrite(input: MemoryWriteInput): {
		action: "created" | "merged" | "rejected";
		record: MemoryRecord;
		existing?: MemoryRecord;
	} {
		const title = input.title.replace(/\s+/g, " ").trim();
		if (title.length > 160) throw new Error("Memory title exceeds 160 characters");
		if (!title.trim() || !input.body.trim()) throw new Error("Memory title and body are required");
		if (Buffer.byteLength(input.body) > 16000)
			throw new Error("Memory exceeds 16000 UTF-8 bytes; summarize it first");
		const existing = this.list(true).find((r) => r.type === input.type && r.title === title);
		if (existing?.file) {
			if (input.source === "hook" && existing.updated.getTime() > Date.now() - 60_000) {
				return { action: "rejected", record: existing, existing };
			}
			const merged: MemoryRecord = {
				...existing,
				body: input.body.trim(),
				salience: Math.max(existing.salience, input.salience ?? DEFAULT_SALIENCE[input.type] ?? 0.5),
				updated: new Date(),
				status: input.status ?? existing.status,
				tags: Array.from(new Set([...existing.tags, ...(input.tags ?? [])])),
				version: (existing.version ?? 1) + 1,
			};
			return { action: "merged", record: merged, existing };
		}
		const now = new Date();
		const record: MemoryRecord = {
			id: stableRecordId(input.type, title),
			type: input.type,
			title,
			body: input.body,
			salience: input.salience ?? DEFAULT_SALIENCE[input.type] ?? 0.5,
			created: now,
			updated: now,
			tags: input.tags ?? [],
			status: input.status ?? (input.type === "promise" ? "open" : undefined),
			version: 1,
			originSessionId: input.originSessionId,
			originCwd: input.originCwd,
			targetProjectId: input.targetProjectId,
		};
		return { action: "created", record, existing: undefined };
	}

	/** Persist a prepared record: history copy for merges, then the atomic write. */
	persist(record: MemoryRecord, existing: MemoryRecord | undefined, skipHistory = false): string {
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const id = record.id ?? stableRecordId(record.type, record.title);
		record = { ...record, id };
		if (existing?.file) {
			if (!skipHistory) {
				mkdirSync(join(this.root, "history"), { recursive: true, mode: 0o700 });
				atomicWrite(join(this.root, "history", `${randomUUID()}.md`), serializeRecord(existing));
			}
			unlinkSync(join(this.root, existing.file));
		}
		const file = `${record.type}-${slugify(record.title)}--${id.replace("rec_", "")}.md`;
		atomicWrite(join(this.root, file), serializeRecord(record));
		this.cache = undefined;
		return file;
	}

	/**
	 * Direct write without runtime-state registration. The unified channel in
	 * `channel.ts` is the production path; this stays for tests and fallbacks.
	 */
	write(input: MemoryWriteInput): MemoryWriteResult {
		return withStorageLock(join(this.root, "store"), () => {
			const prepared = this.prepareWrite(input);
			if (prepared.action === "rejected") {
				return {
					action: "rejected",
					file: prepared.existing?.file ?? "",
					note: "recent duplicate",
					recordId: prepared.existing?.id,
					version: prepared.existing?.version,
				};
			}
			const file = this.persist(prepared.record, prepared.existing);
			return { action: prepared.action, file, recordId: prepared.record.id, version: prepared.record.version };
		});
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
	 * Returns the file names archived, for the caller to register.
	 */
	consolidate(): Array<{ record: MemoryRecord; file: string }> {
		return withStorageLock(join(this.root, "store"), () => {
			const now = new Date();
			const archiveDir = join(this.root, "archive");
			const archived: Array<{ record: MemoryRecord; file: string }> = [];
			const records = this.list(true);
			for (const [index, record] of records.entries()) {
				if (index >= 200 || (record.type === "episode" && decayFactor(record, now) < 0.2)) {
					if (!record.file) continue;
					mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
					atomicWrite(
						join(
							archiveDir,
							existsSync(join(archiveDir, record.file)) ? `${randomUUID()}-${record.file}` : record.file,
						),
						serializeRecord({ ...record, archived: true }),
					);
					unlinkSync(join(this.root, record.file));
					archived.push({ record, file: record.file });
				}
			}
			if (archived.length > 0) this.cache = undefined;
			return archived;
		});
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

/** Old budget helper retained for callers that format context blocks. */
export { fitMemoryBudget, MEMORY_BUDGET };
