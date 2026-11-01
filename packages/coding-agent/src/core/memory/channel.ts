/**
 * Unified memory write channel: one pipeline for every scope that validates,
 * checks versions, journals the file+database double-write, persists the
 * markdown body, registers metadata, appends the change event, and logs an
 * activity. File reads keep using the normal read tool; nothing here adds a
 * second write implementation.
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "../../config.ts";
import {
	defaultScopeForType,
	isHomeDirectory,
	type MemoryScope,
	resolveProjectIdentity,
	scopeKey,
} from "../runtime/identity.ts";
import { getRuntimeState, hashText, type ProjectRow, type RuntimeState } from "../runtime/state-db.ts";
import { withStorageLock } from "../storage.ts";
import { fitMemoryBudget } from "./budget.ts";
import { migrateMemoryLayout } from "./migrate.ts";
import {
	MemoryStore,
	type MemoryWriteInput,
	type MemoryWriteResult,
	memoryRecordFileName,
	readRecordFile,
	serializeMemoryRecord,
	stableRecordId,
} from "./store.ts";

/** Active body ceilings per scope; conservative bytes, not provider tokens. */
export const PERSONA_ACTIVE_BUDGET = 64 * 1024;
export const TOOLBOX_ACTIVE_BUDGET = 32 * 1024;
export const PROJECT_ACTIVE_BUDGET = 32 * 1024;
export const SCRATCH_ACTIVE_BUDGET = 16 * 1024;
/** History archival ceilings; exceeding them pauses archiving, never deletes. */
export const PERSONA_HISTORY_BUDGET = 256 * 1024 * 1024;
export const TOOLBOX_HISTORY_BUDGET = 64 * 1024 * 1024;
export const PROJECT_HISTORY_BUDGET = 64 * 1024 * 1024;
export const SCRATCH_HISTORY_BUDGET = 16 * 1024 * 1024;
/**
 * Active record-count ceilings. Bytes alone let a scope sprawl into dozens of
 * tiny files (one per promise, one per lesson), and every write in a scope
 * bumps its version — the next message then re-injects the whole snapshot, so
 * breadth is as costly as volume. Merging an existing topic is always allowed;
 * only creating a new record past the cap is rejected. Persona's six-record
 * cap plus the four fixed pack files (persona.md, voice, manifest,
 * continuity) keep persona at ten documents total.
 */
export const PERSONA_MAX_RECORDS = 6;
export const TOOLBOX_MAX_RECORDS = 4;
export const PROJECT_MAX_RECORDS = 3;
export const SCRATCH_MAX_RECORDS = 3;

/** Obvious secret literals: private-key blocks and concrete credential assignments. */
const SECRET_MATERIAL =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{8,}/i;

export interface ChannelWriteInput extends MemoryWriteInput {
	scope: MemoryScope;
	/** Version the writer last saw; a mismatch is a conflict, never a silent overwrite. */
	expectedVersion?: number;
}

export interface ChannelWriteResult extends MemoryWriteResult {
	scopeVersion: number;
}

export function personaStore(root = join(getAgentDir(), "memory")): MemoryStore {
	return new MemoryStore(join(root, "persona"));
}

export interface ChannelBudgets {
	personaActive: number;
	toolboxActive: number;
	projectActive: number;
	scratchActive: number;
	personaHistory: number;
	toolboxHistory: number;
	projectHistory: number;
	scratchHistory: number;
	personaMaxRecords: number;
	toolboxMaxRecords: number;
	projectMaxRecords: number;
	scratchMaxRecords: number;
}

const DEFAULT_BUDGETS: ChannelBudgets = {
	personaActive: PERSONA_ACTIVE_BUDGET,
	toolboxActive: TOOLBOX_ACTIVE_BUDGET,
	projectActive: PROJECT_ACTIVE_BUDGET,
	scratchActive: SCRATCH_ACTIVE_BUDGET,
	personaHistory: PERSONA_HISTORY_BUDGET,
	toolboxHistory: TOOLBOX_HISTORY_BUDGET,
	projectHistory: PROJECT_HISTORY_BUDGET,
	scratchHistory: SCRATCH_HISTORY_BUDGET,
	personaMaxRecords: PERSONA_MAX_RECORDS,
	toolboxMaxRecords: TOOLBOX_MAX_RECORDS,
	projectMaxRecords: PROJECT_MAX_RECORDS,
	scratchMaxRecords: SCRATCH_MAX_RECORDS,
};

export class MemoryChannel {
	private readonly stores = new Map<string, MemoryStore>();
	private readonly memoryRoot: string;
	private readonly state: RuntimeState;
	private readonly budgets: ChannelBudgets;

	constructor(
		memoryRoot: string = join(getAgentDir(), "memory"),
		state: RuntimeState = getRuntimeState(),
		budgets: Partial<ChannelBudgets> = {},
	) {
		this.memoryRoot = memoryRoot;
		this.state = state;
		this.budgets = { ...DEFAULT_BUDGETS, ...budgets };
	}

	/** Runtime state for startup bootstrap (migration, recovery). */
	get stateRef(): RuntimeState {
		return this.state;
	}

	store(scope: MemoryScope): MemoryStore {
		const key = scopeKey(scope);
		let store = this.stores.get(key);
		if (!store) {
			if (scope.scope === "persona") store = new MemoryStore(join(this.memoryRoot, "persona"));
			else if (scope.scope === "toolbox") store = new MemoryStore(join(this.memoryRoot, "toolbox"));
			else if (scope.scope === "scratch") store = new MemoryStore(join(this.memoryRoot, "scratch"));
			else
				store = new MemoryStore(join(this.memoryRoot, "projects", this.projectFolder(scope.projectId), "records"));
			this.stores.set(key, store);
		}
		return store;
	}

	/**
	 * Project folder name `<readable>--<hash16>`. Existing folders are found by
	 * hash suffix first, so a renamed project directory keeps one folder.
	 */
	private projectFolder(projectId: string): string {
		const projectsRoot = join(this.memoryRoot, "projects");
		const suffix = `--${projectId.slice(0, 16)}`;
		if (existsSync(projectsRoot)) {
			const match = readdirSync(projectsRoot).find((entry) => entry.endsWith(suffix));
			if (match) return match;
		}
		const name = this.state.getProject(projectId)?.name ?? "project";
		return `${name}${suffix}`;
	}

	/** Resolve the scope for a write, applying the documented default. */
	resolveScope(input: { scope?: unknown; type: string; cwd?: string }): MemoryScope {
		const explicit = input.scope;
		const cwdProject = (): ProjectRow | undefined => {
			if (!input.cwd) return undefined;
			const identity = resolveProjectIdentity(input.cwd);
			this.state.ensureProject(identity);
			return this.state.getProject(identity.projectId) ?? undefined;
		};
		// The tool protocol passes the strings "persona"/"project"/"scratch"; an
		// explicit string must win over the per-type default, or a project-scoped
		// anchor silently lands in the global persona store.
		if (explicit === "persona") return { scope: "persona" };
		if (explicit === "toolbox") return { scope: "toolbox" };
		if (explicit === "scratch") return { scope: "scratch" };
		if (explicit === "project") {
			// Home is not a project: general tasks there route to the toolbox or
			// persona, and a home "project shelf" only ever collected misplaced
			// records. Refuse the write with the correct destinations named.
			if (input.cwd && isHomeDirectory(input.cwd))
				throw new Error(
					"scope 'project' is unavailable in the home directory — home sessions hold general tasks, not a project. Use scope='toolbox' for transferable work knowledge, 'persona' for anything about the user, or — when the knowledge is bound to a specific project you are not inside right now — scope='scratch' with origin_cwd=<that project's path>, then memory_promote with target_project_cwd to file it there",
				);
			const project = cwdProject();
			if (!project) throw new Error("scope 'project' requires a working directory with a resolvable project");
			return { scope: "project", projectId: project.projectId };
		}
		if (explicit && typeof explicit === "object") {
			const value = explicit as MemoryScope;
			if (value.scope === "persona") return { scope: "persona" };
			if (value.scope === "scratch") return { scope: "scratch" };
			if (value.scope === "project" && typeof value.projectId === "string")
				return { scope: "project", projectId: value.projectId };
		}
		const found = cwdProject();
		return defaultScopeForType(
			input.type,
			found
				? {
						projectId: found.projectId,
						canonical: found.canonical,
						original: found.display,
						name: found.name,
						folder: "",
					}
				: undefined,
		);
	}

	/**
	 * Scope owning a filesystem path, when the path lies inside a managed
	 * memory directory (persona records or a project records folder). Plain
	 * write/edit calls on such paths must be re-indexed through the channel.
	 */
	scopeForPath(path: string): MemoryScope | undefined {
		const absolute = isAbsolute(path) ? path : resolve(path);
		const personaDir = join(this.memoryRoot, "persona");
		if (absolute === personaDir || absolute.startsWith(`${personaDir}/`)) return { scope: "persona" };
		const scratchDir = join(this.memoryRoot, "scratch");
		if (absolute === scratchDir || absolute.startsWith(`${scratchDir}/`)) return { scope: "scratch" };
		const projectsRoot = join(this.memoryRoot, "projects");
		if (!absolute.startsWith(`${projectsRoot}/`)) return undefined;
		for (const project of this.state.listProjects()) {
			const recordsDir = join(projectsRoot, this.projectFolder(project.projectId), "records");
			if (absolute === recordsDir || absolute.startsWith(`${recordsDir}/`)) {
				return { scope: "project", projectId: project.projectId };
			}
		}
		return undefined;
	}

	/** Active body bytes for a scope, excluding archives and history. */
	activeBytes(scope: MemoryScope): number {
		return this.store(scope)
			.list(true)
			.reduce((total, record) => total + Buffer.byteLength(record.body), 0);
	}

	private historyBytes(scope: MemoryScope): number {
		const historyDir = join(this.store(scope).dir, "history");
		if (!existsSync(historyDir)) return 0;
		let total = 0;
		for (const name of readdirSync(historyDir)) {
			try {
				total += statSync(join(historyDir, name)).size;
			} catch {
				// A file vanished mid-walk: its size no longer matters.
			}
		}
		return total;
	}

	/** The single production write path. */
	write(input: ChannelWriteInput): ChannelWriteResult {
		const store = this.store(input.scope);
		if (SECRET_MATERIAL.test(input.body)) {
			return {
				action: "rejected",
				file: "",
				note: "secret material in body; store a reference (path, env var, or secret id) instead of the secret itself (not saved)",
				recordId: undefined,
				version: undefined,
				scopeVersion: this.state.scopeVersion(input.scope),
			};
		}
		return withStorageLock(join(store.dir, "store"), () => {
			const state = this.state;
			const prepared = store.prepareWrite(input);
			if (prepared.action === "rejected") {
				return {
					action: "rejected",
					file: prepared.existing?.file ?? "",
					note: "recent duplicate",
					recordId: prepared.existing?.id,
					version: prepared.existing?.version,
					scopeVersion: state.scopeVersion(input.scope),
				};
			}
			// Disk drift check (P1): if the file on disk differs from the last
			// registered hash, a hand edit happened without a sync. Register it
			// first so the authoritative version reflects reality; only then
			// can the conflict check protect the hand-edited content.
			const existingFile = prepared.existing?.file;
			if (existingFile && existsSync(join(store.dir, existingFile))) {
				const diskHash = hashText(readFileSync(join(store.dir, existingFile), "utf8"));
				const recorded = prepared.existing?.id
					? state.getMemoryRecord(input.scope, prepared.existing.id)
					: undefined;
				if (recorded && recorded.contentHash !== diskHash) this.syncExternalChanges(input.scope);
			}
			// The database row is the authoritative version: a hand edit bumps it
			// even while the file's frontmatter still shows the old number, so a
			// stale expectedVersion must conflict instead of overwriting (C03).
			const effectiveId =
				prepared.existing?.id ??
				stableRecordId(prepared.existing?.type ?? input.type, prepared.existing?.title ?? input.title);
			const dbRow = effectiveId ? state.getMemoryRecord(input.scope, effectiveId) : undefined;
			if (prepared.existing && !prepared.existing.id) prepared.existing.id = effectiveId;
			const currentVersion = dbRow?.version ?? prepared.existing?.version;
			if (prepared.existing && input.expectedVersion !== undefined && currentVersion !== input.expectedVersion) {
				return {
					action: "conflict",
					file: prepared.existing.file!,
					note: `version changed: expected ${input.expectedVersion}, current ${currentVersion}`,
					recordId: prepared.existing.id,
					version: currentVersion,
					scopeVersion: state.scopeVersion(input.scope),
				};
			}
			// A record that vanished still guards its topic. expectedVersion
			// means the writer saw SOME version; with nothing on disk there is
			// nothing it could still match (deleted under any id scheme —
			// stable, migrated hash, renamed), so the write conflicts instead
			// of silently resurrecting it (P1).
			if (!prepared.existing && input.expectedVersion !== undefined) {
				// The expected version may belong to a sibling shelf's copy of the
				// same topic (the classic home/project confusion): name it instead
				// of misdiagnosing "deleted". One lookup turns a four-call dance
				// into one correct write.
				const sibling = this.findSiblingTopic(input);
				const note = sibling
					? `expected_version belongs to the ${sibling.scopeLabel} copy of "${input.title}" (v${sibling.version}); the ${scopeKey(input.scope)} shelf has no such record — to update that copy pass scope=${sibling.scopeLabel}, or omit expected_version to create a copy here`
					: "no record at this topic; it was deleted or never existed — re-read and write without expected_version to (re)create";
				return {
					action: "conflict",
					file: "",
					note,
					recordId: effectiveId,
					version: undefined,
					scopeVersion: state.scopeVersion(input.scope),
				};
			}
			const siblingNote = !prepared.existing ? this.findSiblingTopic(input) : undefined;
			// Continue numbering from the database, not a possibly-stale file.
			if (prepared.existing && dbRow && prepared.record.version !== undefined)
				prepared.record.version = dbRow.version + 1;
			// Scope collection budget (M10): a hard ceiling is an honest failure,
			// never a silent truncate or a bypass via smaller extra files.
			const activeBudget =
				input.scope.scope === "persona"
					? this.budgets.personaActive
					: input.scope.scope === "toolbox"
						? this.budgets.toolboxActive
						: input.scope.scope === "project"
							? this.budgets.projectActive
							: this.budgets.scratchActive;
			const oldBytes = prepared.existing ? Buffer.byteLength(prepared.existing.body) : 0;
			const projected = this.activeBytes(input.scope) - oldBytes + Buffer.byteLength(prepared.record.body);
			if (projected > activeBudget) {
				return {
					action: "rejected",
					file: prepared.existing?.file ?? "",
					note: `scope active budget exceeded: ${projected} > ${activeBudget} bytes; merge into an existing record instead of creating a new one — ${this.describeMergeCandidates(store)} (not saved)`,
					recordId: prepared.existing?.id,
					version: prepared.existing?.version,
					scopeVersion: state.scopeVersion(input.scope),
				};
			}
			// Record-count ceiling: merging an existing topic stays possible at
			// the cap (consolidation is the remedy, it must never be blocked);
			// only a brand-new record past the cap is refused.
			const maxRecords =
				input.scope.scope === "persona"
					? this.budgets.personaMaxRecords
					: input.scope.scope === "toolbox"
						? this.budgets.toolboxMaxRecords
						: input.scope.scope === "project"
							? this.budgets.projectMaxRecords
							: this.budgets.scratchMaxRecords;
			if (!prepared.existing && store.list(true).length >= maxRecords) {
				// Task-like content names its real home too: the rejection is the
				// one moment the model is listening for where to put things.
				const taskLike =
					input.type === "episode" || input.type === "procedure"
						? "; if this is task state (what is in progress, what is left to do) it belongs on the continuity note, not in a new record"
						: "";
				return {
					action: "rejected",
					file: "",
					note: `scope record cap reached: ${maxRecords} active records; merge into an existing record instead — ${this.describeMergeCandidates(store)}${taskLike} (not saved)`,
					recordId: undefined,
					version: undefined,
					scopeVersion: state.scopeVersion(input.scope),
				};
			}
			// History archival pauses past its ceiling with a note; the record
			// body itself still saves, and nothing old is ever deleted silently.
			const historyBudget =
				input.scope.scope === "persona"
					? this.budgets.personaHistory
					: input.scope.scope === "toolbox"
						? this.budgets.toolboxHistory
						: input.scope.scope === "project"
							? this.budgets.projectHistory
							: this.budgets.scratchHistory;
			const skipHistory = this.historyBytes(input.scope) > historyBudget;
			const oldHash =
				prepared.existing?.file && existsSync(join(store.dir, prepared.existing.file))
					? hashText(readFileSync(join(store.dir, prepared.existing.file), "utf8"))
					: null;
			const record = { ...prepared.record, id: prepared.record.id ?? effectiveId };
			const file = memoryRecordFileName(record);
			const serialized = serializeMemoryRecord(record);
			const operationId = state.beginJournal({
				scope: input.scope,
				recordId: record.id!,
				oldHash,
				newHash: hashText(serialized),
				file: join(store.dir, file),
				pending: "in-flight",
			});
			store.persist(record, prepared.existing, skipHistory);
			state.markFileWritten(operationId);
			const scopeVersion = state.registerMemoryWrite({
				scope: input.scope,
				recordId: record.id!,
				type: record.type,
				title: record.title,
				file,
				content: serialized,
				status: record.status ?? null,
				occurred: null,
				created: record.created.getTime(),
				change: prepared.action === "created" ? "created" : "updated",
				operationId,
			});
			return {
				action: prepared.action,
				file,
				recordId: record.id,
				version: record.version,
				scopeVersion,
				// Non-blocking cross-shelf duplicate notice: the same topic on a
				// sibling shelf usually means this fact already has a home.
				...(siblingNote
					? {
							note: `same-topic record exists in ${siblingNote.scopeLabel} (v${siblingNote.version}) — confirm this is a distinct fact, not a duplicate`,
						}
					: {}),
				...(prepared.existing?.file
					? {
							previous: {
								version: prepared.existing.version ?? 1,
								body: prepared.existing.body,
								file: prepared.existing.file,
							},
						}
					: {}),
				...(skipHistory
					? {
							note: "history budget reached: previous version archived on disk was skipped, consolidate or export",
						}
					: {}),
			};
		});
	}

	/**
	 * One-line list of a store's active records ("[type] title · [type] title"),
	 * for rejection notes: consolidation needs to name its candidates.
	 */
	private describeMergeCandidates(store: MemoryStore): string {
		const records = store.list(true);
		if (records.length === 0) return "the shelf is empty";
		const totalBudget = 120;
		const parts: string[] = [];
		let used = 0;
		for (const record of records) {
			const part = `[${record.type}] ${record.title}`;
			if (used > 0 && used + part.length > totalBudget) {
				parts.push("…");
				break;
			}
			parts.push(part);
			used += part.length + 3;
		}
		return `candidates: ${parts.join(" · ")}`;
	}

	/**
	 * Same type+title record on a sibling shelf: the other global shelf for a
	 * global write, or both global shelves for a project write. Used to name the
	 * real owner of a stale expected_version and to warn on cross-shelf
	 * duplicates. Scratch writes never consult siblings.
	 */
	private findSiblingTopic(input: ChannelWriteInput): { scopeLabel: string; version: number } | undefined {
		if (input.scope.scope === "scratch") return undefined;
		const candidates: MemoryScope[] =
			input.scope.scope === "persona"
				? [{ scope: "toolbox" }]
				: input.scope.scope === "toolbox"
					? [{ scope: "persona" }]
					: [{ scope: "persona" }, { scope: "toolbox" }];
		const title = input.title.replace(/\s+/g, " ").trim();
		for (const candidate of candidates) {
			const hit = this.store(candidate)
				.list(true)
				.find((record) => record.type === input.type && record.title === title);
			if (hit?.id) {
				const version = this.state.getMemoryRecord(candidate, hit.id)?.version ?? hit.version ?? 1;
				return { scopeLabel: candidate.scope, version };
			}
		}
		return undefined;
	}

	/** Move a scratch record into its final scope, leaving a scratch tombstone. */
	promote(input: { recordId: string; target: MemoryScope; expectedVersion?: number }): ChannelWriteResult {
		if (input.target.scope === "scratch") {
			return {
				action: "rejected",
				file: "",
				note: "scratch cannot be the promotion target",
				recordId: input.recordId,
				version: undefined,
				scopeVersion: this.state.scopeVersion({ scope: "scratch" }),
			};
		}
		const source = this.store({ scope: "scratch" });
		return withStorageLock(join(source.dir, "store"), () => {
			const record = source.list(true).find((item) => item.id === input.recordId);
			if (!record?.id) {
				return {
					action: "rejected",
					file: "",
					note: "no such scratch record",
					recordId: input.recordId,
					version: undefined,
					scopeVersion: this.state.scopeVersion({ scope: "scratch" }),
				};
			}
			// Version gate on the target topic: the promoting model read the
			// scratch draft, never the target book, and a merge REPLACES the
			// target body with the draft. A same-topic record in the target
			// scope therefore demands an explicit acknowledgement of its current
			// version (after merging its content into the draft) — an
			// unacknowledged promote conflicts instead of silently overwriting
			// content the caller has never seen.
			const existingTarget = this.store(input.target)
				.list(true)
				.find((item) => item.type === record.type && item.title === record.title);
			if (existingTarget?.id) {
				const currentVersion =
					this.state.getMemoryRecord(input.target, existingTarget.id)?.version ?? existingTarget.version;
				if (input.expectedVersion !== currentVersion) {
					return {
						action: "conflict",
						file: existingTarget.file ?? "",
						note: `target topic exists at v${currentVersion}; read it, merge its content into the scratch record, then promote with target_version=${currentVersion}`,
						recordId: existingTarget.id,
						version: currentVersion,
						scopeVersion: this.state.scopeVersion(input.target),
					};
				}
			}
			const result = this.write({
				type: record.type,
				title: record.title,
				body: record.body,
				salience: record.salience,
				tags: record.tags,
				status: record.status,
				source: "model",
				scope: input.target,
				expectedVersion: input.expectedVersion,
			});
			if (result.action === "conflict" || result.action === "rejected") return result;
			if (record.file && existsSync(join(source.dir, record.file))) {
				unlinkSync(join(source.dir, record.file));
			}
			this.state.deleteMemoryRecord({ scope: "scratch" }, record.id);
			return {
				...result,
				note: `${result.note ? `${result.note}; ` : ""}promoted from scratch`,
			};
		});
	}

	/** Finish or roll back interrupted double-writes from a previous process. */
	recover(): Array<{ operationId: string; result: string }> {
		const verdicts = this.state.recoverJournal((file) => {
			try {
				return hashText(readFileSync(file, "utf8"));
			} catch {
				return undefined;
			}
		});
		const results: Array<{ operationId: string; result: string }> = [];
		for (const { entry, result } of verdicts) {
			if (result === "completed") {
				const record = readRecordFile(entry.file);
				if (record) {
					const scope: MemoryScope =
						entry.scope === "persona"
							? { scope: "persona" }
							: entry.scope === "scratch"
								? { scope: "scratch" }
								: { scope: "project", projectId: entry.projectId! };
					this.state.registerMemoryWrite({
						scope,
						recordId: entry.recordId,
						type: record.type,
						title: record.title,
						file: basename(entry.file),
						content: readFileSync(entry.file, "utf8"),
						status: record.status ?? null,
						occurred: null,
						created: record.created.getTime(),
						change: "updated",
						operationId: entry.operationId,
					});
					results.push({ operationId: entry.operationId, result: "completed" });
				} else {
					this.state.clearJournalEntry(entry.operationId);
					results.push({ operationId: entry.operationId, result: "rolled_back" });
				}
			} else if (result === "rolled_back") {
				this.state.clearJournalEntry(entry.operationId);
				results.push({ operationId: entry.operationId, result });
			} else {
				results.push({ operationId: entry.operationId, result });
			}
		}
		return results;
	}

	/**
	 * Detect hand edits, renames, and deletions; returns how many were
	 * registered. Files modified within `settleMs` are treated as mid-write
	 * (a model chaining `cat >` then `cat >>` across two tool calls leaves a
	 * parseable half-finished record at the first boundary) and skipped until
	 * they go quiet; a later tool boundary or the next message's scan picks
	 * up the settled file, so nothing is lost — only intermediate states are.
	 */
	syncExternalChanges(scope: MemoryScope, settleMs = 2_000): number {
		const store = this.store(scope);
		if (!existsSync(store.dir)) return 0;
		let changed = 0;
		const seenFiles = new Set<string>();
		const now = Date.now();
		for (const name of readdirSync(store.dir)) {
			if (!name.endsWith(".md")) continue;
			seenFiles.add(name);
			const filePath = join(store.dir, name);
			try {
				if (now - statSync(filePath).mtimeMs < settleMs) continue;
			} catch {
				continue;
			}
			const serialized = readFileSync(filePath, "utf8");
			const record = readRecordFile(filePath);
			if (!record?.id) continue;
			const row = this.state.getMemoryRecord(scope, record.id);
			if (!row || row.contentHash !== hashText(serialized) || row.title !== record.title) {
				this.state.registerMemoryWrite({
					scope,
					recordId: record.id,
					type: record.type,
					title: record.title,
					file: name,
					content: serialized,
					status: record.status ?? null,
					occurred: null,
					created: record.created.getTime(),
					change: row ? "updated" : "imported",
				});
				changed++;
			}
		}
		for (const row of this.state.listMemoryRecords(scope)) {
			if (!seenFiles.has(row.file)) {
				this.state.markExternalChange(scope, row.recordId, "external_delete");
				changed++;
			}
		}
		return changed;
	}

	/** Small on-demand catalog: what exists, where it lives, at which version. */
	catalog(scopes: MemoryScope[], budgetBytes = 2000): string {
		const sections: string[] = [];
		for (const scope of scopes) {
			const store = this.store(scope);
			const version = this.state.scopeVersion(scope);
			const records = store.list(true);
			if (records.length === 0) continue;
			const label =
				scope.scope === "persona"
					? "persona"
					: scope.scope === "toolbox"
						? "toolbox"
						: scope.scope === "scratch"
							? "scratch"
							: `project ${scope.projectId.slice(0, 8)}`;
			const dir = store.dir;
			const lines = records.slice(0, 40).map((record) => {
				const status = record.status ? ` [${record.status}]` : "";
				return `- ${record.type} | ${record.title}${status} | v${record.version ?? 1} | ${dir}/${record.file}`;
			});
			sections.push(`### Memory catalog: ${label} (v${version}, ${records.length} records)\n${lines.join("\n")}`);
		}
		if (sections.length === 0) return "";
		return fitMemoryBudget(
			`${sections.join("\n\n")}\nUse the read tool on a file when its details matter; the catalog is a directory, not the content.`,
			budgetBytes,
		);
	}
}

const channels = new Map<string, MemoryChannel>();

export function getMemoryChannel(memoryRoot = join(getAgentDir(), "memory")): MemoryChannel {
	let channel = channels.get(memoryRoot);
	if (!channel) {
		channel = new MemoryChannel(memoryRoot);
		channels.set(memoryRoot, channel);
		// First use of this root: run the one-time legacy-layout migration and
		// finish interrupted double-writes, so an upgrade never reads as
		// amnesia. Failures are reported, never fatal — the manifest is only
		// written on success, so the next start retries.
		try {
			migrateMemoryLayout(dirname(memoryRoot), channel.stateRef);
		} catch (error) {
			console.error(
				`[memory] layout migration did not complete (${error instanceof Error ? error.message : String(error)}); legacy files are untouched and the next start retries`,
			);
		}
		try {
			channel.recover();
		} catch (error) {
			console.error(`[memory] journal recovery skipped: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return channel;
}
