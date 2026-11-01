/**
 * SQLite-backed runtime state: projects, memory metadata and change log,
 * scope versions, activities, continuity, wardrobe, bridge sessions and
 * message snapshots, context receipts, and the file+database double-write
 * journal. Body text stays in Markdown files; this database holds only
 * deterministic state so multi-process writers have one source of truth.
 *
 * Driver: the Node built-in `node:sqlite` (DatabaseSync). No new dependency.
 * Concurrency: WAL journal mode, a busy timeout, and short IMMEDIATE
 * transactions with bounded retry. No lock is ever held across a model call,
 * a user reply, or a network request.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { getAgentDir } from "../../config.ts";
import { type MemoryScope, scopeKey } from "./identity.ts";

export interface ProjectRow {
	projectId: string;
	canonical: string;
	display: string;
	name: string;
	created: number;
}

export interface MemoryRecordRow {
	recordId: string;
	scope: "persona" | "project" | "scratch";
	projectId: string | null;
	/** Uniqueness owner: 'persona' or the project id. */
	owner: string;
	type: string;
	title: string;
	file: string;
	contentHash: string;
	version: number;
	status: string | null;
	occurred: number | null;
	created: number;
	updated: number;
	bytes: number;
}

export interface MemoryChangeRow {
	seq: number;
	recordId: string;
	scope: "persona" | "project" | "scratch";
	projectId: string | null;
	change: string;
	time: number;
}

export interface ActivityRow {
	seq: number;
	time: number;
	session: string | null;
	messageId: string | null;
	scope: "persona" | "project" | "scratch";
	projectId: string | null;
	kind: string;
	payload: string;
	ref: string | null;
}

export interface ContinuityRow {
	scopeKey: string;
	scope: "persona" | "project" | "scratch";
	projectId: string | null;
	version: number;
	content: string;
	updated: number;
	expires: number | null;
}

export interface WardrobeStateRow {
	locked: string | null;
	current: string | null;
	version: number;
	lastUserAt: number | null;
}

export interface GoalRow {
	session: string;
	goal: string;
	status: string;
	rounds: number;
	maxRounds: number;
	created: number;
	updated: number;
}

export interface OutfitRow {
	id: string;
	name: string;
	description: string;
	enabled: number;
}

export interface SessionRow {
	bridgeId: string;
	nativeId: string | null;
	projectId: string;
	title: string | null;
	historyPath: string | null;
	state: string;
	created: number;
	updated: number;
}

export type MessageState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface MessageRow {
	messageId: string;
	session: string;
	projectId: string;
	received: number;
	timeZone: string;
	text: string;
	/** JSON of the runtime context frozen at receipt, delivered at execution. */
	snapshot: string | null;
	personaVersion: number;
	projectVersion: number;
	activityThrough: number;
	state: MessageState;
	retryOf: string | null;
	created: number;
}

export interface ReceiptRow {
	session: string;
	kind: string;
	ref: string;
	version: number;
	time: number;
}

/**
 * Last body of a record as actually delivered to one session, keyed by the
 * record's receipt ref. A CACHE for diff rendering, not a memory
 * source-of-truth; its lifecycle mirrors the per-record receipts.
 */
export interface MemorySnapshotRow {
	session: string;
	ref: string;
	recordVersion: number;
	body: string;
	time: number;
}

export interface JournalRow {
	operationId: string;
	recordId: string;
	scope: "persona" | "project" | "scratch";
	projectId: string | null;
	oldHash: string | null;
	newHash: string | null;
	stage: "begun" | "file_written" | "committed";
	file: string;
	pending: string;
	time: number;
}

export function hashText(text: string): string {
	return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

const SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  canonical TEXT NOT NULL UNIQUE,
  display TEXT NOT NULL,
  name TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_records (
  record_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('persona','toolbox','project','scratch')),
  project_id TEXT,
  owner TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  file TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT,
  occurred INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (owner, record_id)
);
CREATE INDEX IF NOT EXISTS memory_records_topic ON memory_records(scope, type, title);
CREATE TABLE IF NOT EXISTS memory_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  project_id TEXT,
  change TEXT NOT NULL,
  time INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_changes_scope ON memory_changes(scope, project_id, seq);
CREATE TABLE IF NOT EXISTS scope_versions (
  scope_key TEXT PRIMARY KEY,
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  bridge_id TEXT PRIMARY KEY,
  native_id TEXT,
  project_id TEXT NOT NULL,
  title TEXT,
  history_path TEXT,
  state TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id, updated);
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  project_id TEXT NOT NULL,
  received INTEGER NOT NULL,
  time_zone TEXT NOT NULL,
  text TEXT NOT NULL,
  snapshot TEXT,
  persona_version INTEGER NOT NULL,
  project_version INTEGER NOT NULL,
  activity_through INTEGER NOT NULL,
  state TEXT NOT NULL,
  retry_of TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session, created);
CREATE TABLE IF NOT EXISTS message_memory_versions (
  message_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (message_id, scope_key)
);
CREATE TABLE IF NOT EXISTS context_receipts (
  session TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL,
  time INTEGER NOT NULL,
  PRIMARY KEY (session, kind, ref)
);
-- Delivery snapshots are a per-session CACHE of the last delivered record
-- body, kept only so an update can be rendered as a line diff. Never a
-- memory source-of-truth: bodies live in the Markdown record files.
CREATE TABLE IF NOT EXISTS memory_delivery_snapshots (
  session TEXT NOT NULL,
  ref TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  body TEXT NOT NULL,
  time INTEGER NOT NULL,
  PRIMARY KEY (session, ref)
);
CREATE TABLE IF NOT EXISTS activities (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  time INTEGER NOT NULL,
  session TEXT,
  message_id TEXT,
  scope TEXT NOT NULL,
  project_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  ref TEXT
);
CREATE INDEX IF NOT EXISTS activities_scope ON activities(scope, project_id, seq);
CREATE TABLE IF NOT EXISTS continuity (
  scope_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  project_id TEXT,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  updated INTEGER NOT NULL,
  expires INTEGER
);
CREATE TABLE IF NOT EXISTS outfits (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS wardrobe_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  locked TEXT,
  current TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  last_user_at INTEGER
);
CREATE TABLE IF NOT EXISTS write_journal (
  operation_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  project_id TEXT,
  old_hash TEXT,
  new_hash TEXT,
  stage TEXT NOT NULL,
  file TEXT NOT NULL,
  pending TEXT NOT NULL,
  time INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS goals (
  session TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  rounds INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL DEFAULT 20,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
`;

const BUSY_TIMEOUT_MS = 5000;
const RETRY_DEADLINE_MS = 10_000;

export class RuntimeState {
	private readonly db: DatabaseSync;
	private statements = new Map<string, StatementSync>();

	constructor(file: string) {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		try {
			this.db = new DatabaseSync(file);
			this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON;`);
			this.migrate();
		} catch (error) {
			throw new Error(
				`Runtime state database is unusable (${error instanceof Error ? error.message : String(error)}); refusing to touch it`,
			);
		}
	}

	static defaultFile(root = getAgentDir()): string {
		return join(root, "runtime", "state.sqlite");
	}

	close(): void {
		this.statements.clear();
		this.db.close();
	}

	/** Short IMMEDIATE transaction with bounded busy retry. Never hold it across awaits. */
	transaction<T>(action: () => T): T {
		const deadline = Date.now() + RETRY_DEADLINE_MS;
		for (;;) {
			try {
				this.db.exec("BEGIN IMMEDIATE");
			} catch (error) {
				if (this.isBusy(error) && Date.now() < deadline) {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
					continue;
				}
				throw error;
			}
			try {
				const result = action();
				this.db.exec("COMMIT");
				return result;
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			}
		}
	}

	private isBusy(error: unknown): boolean {
		return error instanceof Error && error.message.includes("SQLITE_BUSY");
	}

	private stmt(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (!statement) {
			statement = this.db.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}

	private migrate(): void {
		// A corrupt file or a database from a newer program must fail loudly:
		// never silently initialize over it (G04).
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.exec(SCHEMA);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw new Error(
				`Runtime state database is unusable (${error instanceof Error ? error.message : String(error)}); refusing to touch it`,
			);
		}
		const row = this.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
			| { version: number | null }
			| undefined;
		const existing = row?.version ?? 0;
		if (existing > SCHEMA_VERSION)
			throw new Error(
				`Runtime state schema version ${existing} is newer than this build supports (${SCHEMA_VERSION}); upgrade neko-pi before opening this data`,
			);
		if (existing < SCHEMA_VERSION) {
			this.transaction(() => {
				if (existing < 2 && this.tableExists("memory_records")) this.migrateRecordsToOwnerKey();
				if (existing < 3 && this.scopeCheckExcludesScratch("memory_records")) {
					this.migrateMemoryRecordsToScratchScope();
				}
				if (existing < 5 && this.scopeCheckExcludesScope("memory_records", "toolbox")) {
					this.migrateMemoryRecordsToToolboxScope();
				}
				this.stmt("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
					SCHEMA_VERSION,
					Date.now(),
				);
			});
		}
	}

	private tableExists(name: string): boolean {
		const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
			| { name: string }
			| undefined;
		return Boolean(row);
	}

	private scopeCheckExcludesScratch(table: string): boolean {
		return this.scopeCheckExcludesScope(table, "scratch");
	}

	private scopeCheckExcludesScope(table: string, scopeName: string): boolean {
		const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
			| { sql: string }
			| undefined;
		return Boolean(row?.sql) && !row!.sql.includes(`'${scopeName}'`);
	}

	/**
	 * v2 constrained memory_records.scope to persona/project. v3 admits scratch;
	 * SQLite cannot edit a CHECK in place, so the table is rebuilt row-for-row.
	 */
	private migrateMemoryRecordsToScratchScope(): void {
		this.rebuildMemoryRecordsTable("memory_records_v3");
	}

	/**
	 * v5 rebuild: the scope CHECK admits 'toolbox' (the person's cross-project
	 * work shelf). Rows are copied verbatim; metadata survives.
	 */
	private migrateMemoryRecordsToToolboxScope(): void {
		this.rebuildMemoryRecordsTable("memory_records_v5");
	}

	private rebuildMemoryRecordsTable(tempName: string): void {
		this.db.exec(
			`CREATE TABLE ${tempName} (
			   record_id TEXT NOT NULL,
			   scope TEXT NOT NULL CHECK (scope IN ('persona','toolbox','project','scratch')),
			   project_id TEXT,
			   owner TEXT NOT NULL,
			   type TEXT NOT NULL,
			   title TEXT NOT NULL,
			   file TEXT NOT NULL,
			   content_hash TEXT NOT NULL,
			   version INTEGER NOT NULL,
			   status TEXT,
			   occurred INTEGER,
			   created INTEGER NOT NULL,
			   updated INTEGER NOT NULL,
			   bytes INTEGER NOT NULL,
			   PRIMARY KEY (owner, record_id)
			 )`,
		);
		this.db.exec(
			`INSERT INTO ${tempName} SELECT record_id, scope, project_id, owner, type, title,
			   file, content_hash, version, status, occurred, created, updated, bytes FROM memory_records`,
		);
		this.db.exec("DROP TABLE memory_records");
		this.db.exec(`ALTER TABLE ${tempName} RENAME TO memory_records`);
		this.db.exec("CREATE INDEX IF NOT EXISTS memory_records_topic ON memory_records(scope, type, title)");
	}

	/**
	 * v1 keyed rows by (scope, record_id): two projects writing the same
	 * topic collided and overwrote each other's metadata. v2 keys by
	 * (owner, record_id) where owner is 'persona' or the project id.
	 */
	private migrateRecordsToOwnerKey(): void {
		this.db.exec(
			`CREATE TABLE memory_records_v2 (
			   record_id TEXT NOT NULL,
			   scope TEXT NOT NULL CHECK (scope IN ('persona','toolbox','project','scratch')),
			   project_id TEXT,
			   owner TEXT NOT NULL,
			   type TEXT NOT NULL,
			   title TEXT NOT NULL,
			   file TEXT NOT NULL,
			   content_hash TEXT NOT NULL,
			   version INTEGER NOT NULL,
			   status TEXT,
			   occurred INTEGER,
			   created INTEGER NOT NULL,
			   updated INTEGER NOT NULL,
			   bytes INTEGER NOT NULL,
			   PRIMARY KEY (owner, record_id)
			 )`,
		);
		this.db.exec(
			`INSERT INTO memory_records_v2 SELECT record_id, scope, project_id,
			   COALESCE(project_id, 'persona'), type, title, file, content_hash, version,
			   status, occurred, created, updated, bytes FROM memory_records`,
		);
		this.db.exec("DROP TABLE memory_records");
		this.db.exec("ALTER TABLE memory_records_v2 RENAME TO memory_records");
		this.db.exec("CREATE INDEX IF NOT EXISTS memory_records_topic ON memory_records(scope, type, title)");
	}

	// ------------------------------------------------------------------
	// Projects
	// ------------------------------------------------------------------

	ensureProject(project: { projectId: string; canonical: string; original: string; name: string }): void {
		this.transaction(() => {
			const existing = this.stmt("SELECT project_id FROM projects WHERE project_id = ?").get(project.projectId);
			if (existing) return;
			const byCanonical = this.stmt("SELECT project_id FROM projects WHERE canonical = ?").get(project.canonical);
			if (byCanonical) return;
			this.stmt("INSERT INTO projects (project_id, canonical, display, name, created) VALUES (?, ?, ?, ?, ?)").run(
				project.projectId,
				project.canonical,
				project.original,
				project.name,
				Date.now(),
			);
		});
	}

	getProject(projectId: string): ProjectRow | undefined {
		const row = this.stmt(
			"SELECT project_id AS projectId, canonical, display, name, created FROM projects WHERE project_id = ?",
		).get(projectId);
		return (row as ProjectRow | undefined) ?? undefined;
	}

	findProjectByCanonical(canonical: string): ProjectRow | undefined {
		const row = this.stmt(
			"SELECT project_id AS projectId, canonical, display, name, created FROM projects WHERE canonical = ?",
		).get(canonical);
		return (row as ProjectRow | undefined) ?? undefined;
	}

	listProjects(): ProjectRow[] {
		return this.stmt(
			"SELECT project_id AS projectId, canonical, display, name, created FROM projects ORDER BY created",
		).all() as unknown as ProjectRow[];
	}

	// ------------------------------------------------------------------
	// Memory metadata, scope versions, changes
	// ------------------------------------------------------------------

	/** Row owner: 'persona', 'scratch', or the project id — the uniqueness key beside record_id. */
	private ownerOf(scope: MemoryScope): string {
		if (scope.scope === "persona") return "persona";
		if (scope.scope === "toolbox") return "toolbox";
		if (scope.scope === "scratch") return "scratch";
		return scope.projectId;
	}

	scopeVersion(scope: MemoryScope): number {
		const key = scopeKey(scope);
		const row = this.stmt("SELECT version FROM scope_versions WHERE scope_key = ?").get(key) as
			| { version: number }
			| undefined;
		return row?.version ?? 0;
	}

	getMemoryRecord(scope: MemoryScope, recordId: string): MemoryRecordRow | undefined {
		const row = this.stmt(
			"SELECT record_id AS recordId, scope, project_id AS projectId, owner, type, title, file, content_hash AS contentHash, version, status, occurred, created, updated, bytes FROM memory_records WHERE owner = ? AND record_id = ?",
		).get(this.ownerOf(scope), recordId);
		return (row as MemoryRecordRow | undefined) ?? undefined;
	}

	findMemoryRecordByTopic(scope: MemoryScope, type: string, title: string): MemoryRecordRow | undefined {
		const row = this.stmt(
			"SELECT record_id AS recordId, scope, project_id AS projectId, owner, type, title, file, content_hash AS contentHash, version, status, occurred, created, updated, bytes FROM memory_records WHERE owner = ? AND type = ? AND title = ?",
		).get(this.ownerOf(scope), type, title);
		return (row as MemoryRecordRow | undefined) ?? undefined;
	}

	listMemoryRecords(scope: MemoryScope): MemoryRecordRow[] {
		return this.stmt(
			"SELECT record_id AS recordId, scope, project_id AS projectId, owner, type, title, file, content_hash AS contentHash, version, status, occurred, created, updated, bytes FROM memory_records WHERE owner = ? ORDER BY updated DESC",
		).all(this.ownerOf(scope)) as unknown as MemoryRecordRow[];
	}

	/**
	 * Register a completed memory write in one transaction: upsert the record,
	 * bump the scope version, append a change event, and finish the journal
	 * operation when one was begun for this write.
	 */
	registerMemoryWrite(input: {
		scope: MemoryScope;
		recordId: string;
		type: string;
		title: string;
		file: string;
		content: string;
		status: string | null;
		occurred: number | null;
		created: number;
		change: "created" | "updated" | "renamed" | "imported";
		operationId?: string;
	}): number {
		const key = scopeKey(input.scope);
		const projectId = input.scope.scope === "project" ? input.scope.projectId : null;
		const contentHash = hashText(input.content);
		const bytes = Buffer.byteLength(input.content);
		return this.transaction(() => {
			const previous = this.getMemoryRecord(input.scope, input.recordId);
			const version = (previous?.version ?? 0) + 1;
			this.stmt(
				`INSERT INTO memory_records (record_id, scope, project_id, owner, type, title, file, content_hash, version, status, occurred, created, updated, bytes)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(owner, record_id) DO UPDATE SET type = excluded.type, title = excluded.title, file = excluded.file,
				 content_hash = excluded.content_hash, version = excluded.version, status = excluded.status,
				 occurred = excluded.occurred, updated = excluded.updated, bytes = excluded.bytes`,
			).run(
				input.recordId,
				input.scope.scope,
				projectId,
				this.ownerOf(input.scope),
				input.type,
				input.title,
				input.file,
				contentHash,
				version,
				input.status,
				input.occurred,
				previous?.created ?? input.created,
				Date.now(),
				bytes,
			);
			const bumped = this.bumpScopeVersionLocked(key);
			this.stmt(
				"INSERT INTO memory_changes (record_id, scope, project_id, change, time) VALUES (?, ?, ?, ?, ?)",
			).run(input.recordId, input.scope.scope, projectId, input.change, Date.now());
			if (input.operationId) this.clearJournalLocked(input.operationId);
			return bumped;
		});
	}

	private bumpScopeVersionLocked(key: string): number {
		this.stmt(
			"INSERT INTO scope_versions (scope_key, version) VALUES (?, 1) ON CONFLICT(scope_key) DO UPDATE SET version = version + 1",
		).run(key);
		const row = this.stmt("SELECT version FROM scope_versions WHERE scope_key = ?").get(key) as { version: number };
		return row.version;
	}

	deleteMemoryRecord(scope: MemoryScope, recordId: string): void {
		const projectId = scope.scope === "project" ? scope.projectId : null;
		this.transaction(() => {
			this.stmt("DELETE FROM memory_records WHERE owner = ? AND record_id = ?").run(this.ownerOf(scope), recordId);
			this.bumpScopeVersionLocked(scopeKey(scope));
			this.stmt(
				"INSERT INTO memory_changes (record_id, scope, project_id, change, time) VALUES (?, ?, ?, 'deleted', ?)",
			).run(recordId, scope.scope, projectId, Date.now());
		});
	}

	/** Register an out-of-band change: a hand deletion removes the row, the tombstone stays in changes. */
	markExternalChange(scope: MemoryScope, recordId: string, change: "external_edit" | "external_delete"): void {
		const projectId = scope.scope === "project" ? scope.projectId : null;
		this.transaction(() => {
			if (change === "external_delete")
				this.stmt("DELETE FROM memory_records WHERE owner = ? AND record_id = ?").run(
					this.ownerOf(scope),
					recordId,
				);
			this.bumpScopeVersionLocked(scopeKey(scope));
			this.stmt(
				"INSERT INTO memory_changes (record_id, scope, project_id, change, time) VALUES (?, ?, ?, ?, ?)",
			).run(recordId, scope.scope, projectId, change, Date.now());
		});
	}

	/** Changes a viewer may see: persona plus at most one project. */
	changesSince(sinceSeq: number, includeProjectId: string | null): MemoryChangeRow[] {
		return this.stmt(
			`SELECT seq, record_id AS recordId, scope, project_id AS projectId, change, time FROM memory_changes
			 WHERE seq > ? AND (scope = 'persona' OR project_id IS ?) ORDER BY seq`,
		).all(sinceSeq, includeProjectId) as unknown as MemoryChangeRow[];
	}

	lastChangeSeq(): number {
		const row = this.stmt("SELECT COALESCE(MAX(seq), 0) AS seq FROM memory_changes").get() as { seq: number };
		return row.seq;
	}

	// ------------------------------------------------------------------
	// Double-write journal
	// ------------------------------------------------------------------

	beginJournal(entry: {
		scope: MemoryScope;
		recordId: string;
		oldHash: string | null;
		newHash: string;
		file: string;
		pending: string;
	}): string {
		const projectId = entry.scope.scope === "project" ? entry.scope.projectId : null;
		const operationId = `op_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
		this.transaction(() => {
			this.stmt(
				`INSERT INTO write_journal (operation_id, record_id, scope, project_id, old_hash, new_hash, stage, file, pending, time)
				 VALUES (?, ?, ?, ?, ?, ?, 'begun', ?, ?, ?)`,
			).run(
				operationId,
				entry.recordId,
				entry.scope.scope,
				projectId,
				entry.oldHash,
				entry.newHash,
				entry.file,
				entry.pending,
				Date.now(),
			);
		});
		return operationId;
	}

	markFileWritten(operationId: string): void {
		this.transaction(() => {
			this.stmt("UPDATE write_journal SET stage = 'file_written' WHERE operation_id = ?").run(operationId);
		});
	}

	private clearJournalLocked(operationId: string): void {
		this.stmt("DELETE FROM write_journal WHERE operation_id = ?").run(operationId);
	}

	listJournal(): JournalRow[] {
		return this.stmt(
			"SELECT operation_id AS operationId, record_id AS recordId, scope, project_id AS projectId, old_hash AS oldHash, new_hash AS newHash, stage, file, pending, time FROM write_journal",
		).all() as unknown as JournalRow[];
	}

	/**
	 * Crash recovery for interrupted double-writes, classification only. The
	 * caller — the memory channel, which understands the Markdown body —
	 * completes or clears the entry based on this verdict. A verdict is
	 * computed purely from hashes, so retrying recovery is idempotent.
	 */
	recoverJournal(
		onDisk: (file: string) => string | undefined,
	): Array<{ entry: JournalRow; result: "completed" | "rolled_back" | "conflict" }> {
		const results: Array<{ entry: JournalRow; result: "completed" | "rolled_back" | "conflict" }> = [];
		for (const entry of this.listJournal()) {
			const disk = onDisk(entry.file);
			if (disk === entry.newHash) results.push({ entry, result: "completed" });
			else if (disk === entry.oldHash || (entry.oldHash === null && disk === undefined))
				results.push({ entry, result: "rolled_back" });
			else results.push({ entry, result: "conflict" });
		}
		return results;
	}

	clearJournalEntry(operationId: string): void {
		this.transaction(() => this.clearJournalLocked(operationId));
	}

	// ------------------------------------------------------------------
	// Activities
	// ------------------------------------------------------------------

	appendActivity(input: {
		session: string | null;
		messageId?: string;
		scope: MemoryScope;
		kind: string;
		payload: string;
		ref?: string;
		now?: number;
	}): number {
		const projectId = input.scope.scope === "project" ? input.scope.projectId : null;
		return this.transaction(() => {
			this.stmt(
				"INSERT INTO activities (time, session, message_id, scope, project_id, kind, payload, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				input.now ?? Date.now(),
				input.session,
				input.messageId ?? null,
				input.scope.scope,
				projectId,
				input.kind,
				input.payload,
				input.ref ?? null,
			);
			const row = this.stmt("SELECT last_insert_rowid() AS seq").get() as { seq: number };
			return row.seq;
		});
	}

	lastActivitySeq(): number {
		const row = this.stmt("SELECT COALESCE(MAX(seq), 0) AS seq FROM activities").get() as { seq: number };
		return row.seq;
	}

	/**
	 * Budgeted selection of unknown activity rows, filled newest-first with a
	 * break at the first row that no longer fits. With reserveQueriesPerSession
	 * > 0 (the digest delivery path), that many newest user queries of each
	 * session are reserved before the fill: without it, a burst of recent
	 * continuity or memory rows can consume the whole budget and evict every
	 * query preview from the window. If the reservations alone cannot fit the
	 * budget, the newest reserved queries are kept and selection stops —
	 * queries own the budget before other rows. Output stays sequence-
	 * ascending regardless of selection order; omitted is unknown rows minus
	 * selected ones (C04/C06).
	 */
	activitiesSince(
		sinceSeq: number,
		includeProjectId: string | null,
		maxBytes: number,
		excludeSeqs?: Set<number>,
		reserveQueriesPerSession = 0,
	): { events: ActivityRow[]; omitted: number } {
		const rows = this.stmt(
			`SELECT seq, time, session, message_id AS messageId, scope, project_id AS projectId, kind, payload, ref FROM activities
			 WHERE seq > ? AND (scope = 'persona' OR project_id IS ?) ORDER BY seq`,
		).all(sinceSeq, includeProjectId) as unknown as ActivityRow[];
		// Known-by-receipt events are skipped entirely: they consume no budget
		// and do not count as omitted unknowns (C04/C06).
		const unknown = excludeSeqs ? rows.filter((row) => !excludeSeqs.has(row.seq)) : rows;
		const newest = unknown.toReversed();
		const selected = new Map<number, ActivityRow>();
		let bytes = 0;
		let queriesSaturated = false;
		if (reserveQueriesPerSession > 0) {
			const reservedPerSession = new Map<string, number>();
			for (const row of newest) {
				if (row.kind !== "user_query") continue;
				const owner = row.session ?? "";
				if ((reservedPerSession.get(owner) ?? 0) >= reserveQueriesPerSession) continue;
				const size = Buffer.byteLength(row.payload);
				if (bytes + size > maxBytes) {
					queriesSaturated = true;
					break;
				}
				selected.set(row.seq, row);
				reservedPerSession.set(owner, (reservedPerSession.get(owner) ?? 0) + 1);
				bytes += size;
			}
		}
		if (!queriesSaturated) {
			for (const row of newest) {
				if (selected.has(row.seq)) continue;
				const size = Buffer.byteLength(row.payload);
				if (bytes + size > maxBytes) break;
				selected.set(row.seq, row);
				bytes += size;
			}
		}
		const events = [...selected.values()].sort((a, b) => a.seq - b.seq);
		return { events, omitted: unknown.length - events.length };
	}

	pruneActivities(now: number, retentionMs: number): number {
		const cutoff = now - retentionMs;
		return this.transaction(() => {
			const removed = this.stmt("DELETE FROM activities WHERE time < ?").run(cutoff);
			return Number(removed.changes);
		});
	}

	activityPrunedThrough(now: number, retentionMs: number): number {
		const row = this.stmt("SELECT COALESCE(MAX(seq), 0) AS seq FROM activities WHERE time < ?").get(
			now - retentionMs,
		) as { seq: number };
		return row.seq;
	}

	// ------------------------------------------------------------------
	// Continuity
	// ------------------------------------------------------------------

	getContinuity(key: string): ContinuityRow | undefined {
		const row = this.stmt(
			"SELECT scope_key AS scopeKey, scope, project_id AS projectId, version, content, updated, expires FROM continuity WHERE scope_key = ?",
		).get(key);
		return (row as ContinuityRow | undefined) ?? undefined;
	}

	setContinuity(input: {
		key: string;
		scope: MemoryScope;
		content: string;
		expires: number | null;
		expectedVersion?: number;
		/** Preserve an existing timestamp instead of stamping now (claims). */
		updatedAt?: number;
	}): { saved: boolean; version: number } {
		return this.transaction(() => {
			const current = this.getContinuity(input.key);
			if (input.expectedVersion !== undefined && (current?.version ?? 0) !== input.expectedVersion) {
				return { saved: false, version: current?.version ?? 0 };
			}
			const version = (current?.version ?? 0) + 1;
			const stamp = input.updatedAt ?? Date.now();
			this.stmt(
				`INSERT INTO continuity (scope_key, scope, project_id, version, content, updated, expires)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(scope_key) DO UPDATE SET version = excluded.version, content = excluded.content,
				 updated = excluded.updated, expires = excluded.expires`,
			).run(
				input.key,
				input.scope.scope,
				input.scope.scope === "project" ? input.scope.projectId : null,
				version,
				input.content,
				stamp,
				input.expires,
			);
			return { saved: true, version };
		});
	}

	// ------------------------------------------------------------------
	// Wardrobe
	// ------------------------------------------------------------------

	/** Replace outfit definitions from the editable wardrobe.json, preserving the current selection when valid. */
	importWardrobe(
		outfits: Array<{ id: string; name: string; description: string; enabled: boolean }>,
		locked: string | null,
	): void {
		this.transaction(() => {
			this.stmt("DELETE FROM outfits").run();
			for (const outfit of outfits) {
				this.stmt("INSERT INTO outfits (id, name, description, enabled) VALUES (?, ?, ?, ?)").run(
					outfit.id,
					outfit.name,
					outfit.description,
					outfit.enabled ? 1 : 0,
				);
			}
			const state = this.getWardrobeState();
			const currentValid = state.current && outfits.some((outfit) => outfit.id === state.current && outfit.enabled);
			this.stmt(
				`INSERT INTO wardrobe_state (id, locked, current, version, last_user_at) VALUES (1, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET locked = excluded.locked,
				 current = CASE WHEN ? THEN excluded.current ELSE NULL END, version = version + 1`,
			).run(
				locked,
				currentValid ? state.current : null,
				state.version,
				state.lastUserAt ?? null,
				currentValid ? 1 : 0,
			);
		});
	}

	getWardrobeState(): WardrobeStateRow {
		const row = this.stmt(
			"SELECT locked, current, version, last_user_at AS lastUserAt FROM wardrobe_state WHERE id = 1",
		).get() as WardrobeStateRow | undefined;
		return row ?? { locked: null, current: null, version: 0, lastUserAt: null };
	}

	setWardrobeSelection(current: string | null, lastUserAt: number | null): void {
		this.transaction(() => {
			const state = this.getWardrobeState();
			this.stmt(
				`INSERT INTO wardrobe_state (id, locked, current, version, last_user_at) VALUES (1, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET current = excluded.current, version = version + 1,
				 last_user_at = CASE WHEN excluded.last_user_at IS NULL THEN wardrobe_state.last_user_at ELSE excluded.last_user_at END`,
			).run(state.locked, current, state.version + 1, lastUserAt);
		});
	}

	listOutfits(enabledOnly: boolean): OutfitRow[] {
		const rows = this.stmt(
			"SELECT id, name, description, enabled FROM outfits ORDER BY id",
		).all() as unknown as OutfitRow[];
		return enabledOnly ? rows.filter((row) => row.enabled === 1) : rows;
	}

	// ------------------------------------------------------------------
	// Goals (zcode-style autonomous continuation)
	// ------------------------------------------------------------------

	getGoal(session: string): GoalRow | undefined {
		return this.stmt(
			"SELECT session, goal, status, rounds, max_rounds AS maxRounds, created, updated FROM goals WHERE session = ?",
		).get(session) as GoalRow | undefined;
	}

	setGoal(session: string, goal: string, maxRounds: number): void {
		const now = Date.now();
		this.stmt(
			`INSERT INTO goals (session, goal, status, rounds, max_rounds, created, updated)
			 VALUES (?, ?, 'active', 0, ?, ?, ?)
			 ON CONFLICT(session) DO UPDATE SET goal = excluded.goal, status = 'active',
			 rounds = 0, max_rounds = excluded.max_rounds, updated = excluded.updated`,
		).run(session, goal, maxRounds, now, now);
	}

	updateGoal(session: string, patch: { status?: string; roundsDelta?: number }): void {
		const current = this.getGoal(session);
		if (!current) return;
		this.stmt("UPDATE goals SET status = ?, rounds = ?, updated = ? WHERE session = ?").run(
			patch.status ?? current.status,
			current.rounds + (patch.roundsDelta ?? 0),
			Date.now(),
			session,
		);
	}

	clearGoal(session: string): void {
		this.stmt("DELETE FROM goals WHERE session = ?").run(session);
	}

	// ------------------------------------------------------------------
	// Bridge sessions and messages
	// ------------------------------------------------------------------

	upsertSession(input: {
		bridgeId: string;
		projectId: string;
		nativeId?: string;
		title?: string;
		historyPath?: string;
		state: string;
	}): void {
		this.transaction(() => {
			const existing = this.stmt(
				"SELECT bridge_id AS bridgeId, native_id AS nativeId, project_id AS projectId, title, history_path AS historyPath, state, created, updated FROM sessions WHERE bridge_id = ?",
			).get(input.bridgeId) as SessionRow | undefined;
			// A session's project binding is fixed at creation; later calls must not silently rebind it.
			if (existing && existing.projectId !== input.projectId)
				throw new Error(`Session ${input.bridgeId} is bound to a different project`);
			this.stmt(
				`INSERT INTO sessions (bridge_id, native_id, project_id, title, history_path, state, created, updated)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(bridge_id) DO UPDATE SET native_id = COALESCE(excluded.native_id, sessions.native_id),
				 title = COALESCE(excluded.title, sessions.title), history_path = COALESCE(excluded.history_path, sessions.history_path),
				 state = excluded.state, updated = excluded.updated`,
			).run(
				input.bridgeId,
				input.nativeId ?? null,
				input.projectId,
				input.title ?? null,
				input.historyPath ?? null,
				input.state,
				existing?.created ?? Date.now(),
				Date.now(),
			);
		});
	}

	getSession(bridgeId: string): SessionRow | undefined {
		const row = this.stmt(
			"SELECT bridge_id AS bridgeId, native_id AS nativeId, project_id AS projectId, title, history_path AS historyPath, state, created, updated FROM sessions WHERE bridge_id = ?",
		).get(bridgeId);
		return (row as SessionRow | undefined) ?? undefined;
	}

	listSessions(): SessionRow[] {
		return this.stmt(
			"SELECT bridge_id AS bridgeId, native_id AS nativeId, project_id AS projectId, title, history_path AS historyPath, state, created, updated FROM sessions ORDER BY updated DESC",
		).all() as unknown as SessionRow[];
	}

	/** Deduplicating message intake. Returns false when the message ID already exists. */
	enqueueMessage(input: Omit<MessageRow, "created" | "snapshot"> & { snapshot?: string | null }): boolean {
		return this.transaction(() => {
			const existing = this.stmt("SELECT message_id FROM messages WHERE message_id = ?").get(input.messageId);
			if (existing) return false;
			this.stmt(
				`INSERT INTO messages (message_id, session, project_id, received, time_zone, text, snapshot, persona_version, project_version, activity_through, state, retry_of, created)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				input.messageId,
				input.session,
				input.projectId,
				input.received,
				input.timeZone,
				input.text,
				input.snapshot ?? null,
				input.personaVersion,
				input.projectVersion,
				input.activityThrough,
				input.state,
				input.retryOf,
				Date.now(),
			);
			this.stmt("INSERT INTO message_memory_versions (message_id, scope_key, version) VALUES (?, 'persona', ?)").run(
				input.messageId,
				input.personaVersion,
			);
			this.stmt("INSERT INTO message_memory_versions (message_id, scope_key, version) VALUES (?, ?, ?)").run(
				input.messageId,
				`project:${input.projectId}`,
				input.projectVersion,
			);
			return true;
		});
	}

	getMessage(messageId: string): MessageRow | undefined {
		const row = this.stmt(
			"SELECT message_id AS messageId, session, project_id AS projectId, received, time_zone AS timeZone, text, snapshot, persona_version AS personaVersion, project_version AS projectVersion, activity_through AS activityThrough, state, retry_of AS retryOf, created FROM messages WHERE message_id = ?",
		).get(messageId);
		return (row as MessageRow | undefined) ?? undefined;
	}

	setMessageState(messageId: string, state: MessageState): void {
		this.transaction(() => {
			this.stmt("UPDATE messages SET state = ? WHERE message_id = ?").run(state, messageId);
		});
	}

	listMessages(session: string): MessageRow[] {
		return this.stmt(
			"SELECT message_id AS messageId, session, project_id AS projectId, received, time_zone AS timeZone, text, snapshot, persona_version AS personaVersion, project_version AS projectVersion, activity_through AS activityThrough, state, retry_of AS retryOf, created FROM messages WHERE session = ? ORDER BY created",
		).all(session) as unknown as MessageRow[];
	}

	// ------------------------------------------------------------------
	// Context receipts
	// ------------------------------------------------------------------

	markReceipt(session: string, kind: string, version: number, ref = ""): void {
		this.transaction(() => {
			this.stmt(
				`INSERT INTO context_receipts (session, kind, ref, version, time) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(session, kind, ref) DO UPDATE SET version = excluded.version, time = excluded.time`,
			).run(session, kind, ref, version, Date.now());
		});
	}

	getReceipt(session: string, kind: string, ref = ""): ReceiptRow | undefined {
		const row = this.stmt(
			"SELECT session, kind, ref, version, time FROM context_receipts WHERE session = ? AND kind = ? AND ref = ?",
		).get(session, kind, ref);
		return (row as ReceiptRow | undefined) ?? undefined;
	}

	/**
	 * Drop every delivery receipt of one session. History truncation (/edit,
	 * /undo) removes injected text the receipts still claim was delivered —
	 * after a truncation the session resends with nothing held back. The
	 * snapshot cache mirrors the reset: the honest resend baselines full
	 * bodies, so no diff target remains valid.
	 */
	clearSessionReceipts(session: string): void {
		this.transaction(() => {
			this.stmt("DELETE FROM context_receipts WHERE session = ?").run(session);
			this.stmt("DELETE FROM memory_delivery_snapshots WHERE session = ?").run(session);
		});
	}

	/**
	 * Drop one delivery receipt of a session. Per-record receipts are cleared
	 * individually: compaction wants an honest baseline resend (not a confusing
	 * "update" of documents the model no longer has), and a delivered
	 * tombstone must not repeat on every later query.
	 */
	clearReceipt(session: string, kind: string, ref = ""): void {
		this.stmt("DELETE FROM context_receipts WHERE session = ? AND kind = ? AND ref = ?").run(session, kind, ref);
	}

	/**
	 * Mark one activity event as known for a session because its result
	 * entered that session's history directly (a tool result, typically).
	 * Per-event receipts must not advance the session's cursor: earlier
	 * unknown events stay deliverable (C04/C06).
	 */
	markEventKnown(session: string, seq: number): void {
		this.markReceipt(session, "activity_event", seq, `seq:${seq}`);
	}

	/** Activity sequence numbers this session already saw outside a snapshot. */
	knownEventSeqs(session: string): Set<number> {
		const rows = this.stmt("SELECT version FROM context_receipts WHERE session = ? AND kind = 'activity_event'").all(
			session,
		) as Array<{ version: number }>;
		return new Set(rows.map((row) => row.version));
	}

	/** Receipts of one kind for a session, by ref. */
	listReceipts(session: string, kind: string): ReceiptRow[] {
		return this.stmt(
			"SELECT session, kind, ref, version, time FROM context_receipts WHERE session = ? AND kind = ?",
		).all(session, kind) as unknown as ReceiptRow[];
	}

	// ------------------------------------------------------------------
	// Memory delivery snapshots (per-session diff cache, NOT source-of-truth)
	// ------------------------------------------------------------------

	upsertMemorySnapshot(session: string, ref: string, recordVersion: number, body: string): void {
		this.transaction(() => {
			this.stmt(
				`INSERT INTO memory_delivery_snapshots (session, ref, record_version, body, time) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(session, ref) DO UPDATE SET record_version = excluded.record_version,
				 body = excluded.body, time = excluded.time`,
			).run(session, ref, recordVersion, body, Date.now());
		});
	}

	getMemorySnapshot(session: string, ref: string): MemorySnapshotRow | undefined {
		const row = this.stmt(
			"SELECT session, ref, record_version AS recordVersion, body, time FROM memory_delivery_snapshots WHERE session = ? AND ref = ?",
		).get(session, ref);
		return (row as MemorySnapshotRow | undefined) ?? undefined;
	}

	/** Drop the snapshots of specific refs; mirrors per-receipt clears (tombstones, promotions). */
	deleteMemorySnapshots(session: string, refs: string[]): void {
		if (refs.length === 0) return;
		this.transaction(() => {
			for (const ref of refs)
				this.stmt("DELETE FROM memory_delivery_snapshots WHERE session = ? AND ref = ?").run(session, ref);
		});
	}

	/** Drop every snapshot of a session; mirrors clearSessionReceipts and the compaction reset. */
	deleteSessionMemorySnapshots(session: string): void {
		this.stmt("DELETE FROM memory_delivery_snapshots WHERE session = ?").run(session);
	}
}

const states = new Map<string, RuntimeState>();

/** Shared instance for a database file; keeps one connection per process. */
export function getRuntimeState(file = RuntimeState.defaultFile()): RuntimeState {
	let state = states.get(file);
	if (!state) {
		state = new RuntimeState(file);
		states.set(file, state);
	}
	return state;
}
