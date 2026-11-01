import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryChannel } from "../src/core/memory/channel.ts";
import { buildMemoryDelivery } from "../src/core/memory/delivery.ts";
import {
	inventoryMemory,
	migrateMemoryLayout,
	readMigrationManifest,
	rollbackMigration,
} from "../src/core/memory/migrate.ts";
import {
	type MemoryRecord,
	memoryRecordFileName,
	serializeMemoryRecord,
	stableRecordId,
} from "../src/core/memory/store.ts";
import { resolveProjectIdentity } from "../src/core/runtime/identity.ts";
import { hashText, RuntimeState } from "../src/core/runtime/state-db.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function legacyRoot() {
	const root = mkdtempSync(join(tmpdir(), "neko-migrate-"));
	scratch.push(root);
	mkdirSync(join(root, "memory"), { recursive: true });
	return root;
}

function writeLegacy(root: string, name: string, frontmatter: string, body: string) {
	writeFileSync(join(root, "memory", name), `---\n${frontmatter}---\n\n${body}\n`);
}

/** Plant a record file exactly as the store serializes it; returns name and bytes. */
function plantRecord(dir: string, record: MemoryRecord) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = memoryRecordFileName(record);
	const serialized = serializeMemoryRecord(record);
	writeFileSync(join(dir, file), serialized);
	return { file, serialized };
}

describe("memory layout migration", () => {
	test("inventory classifies personal and work records without touching files", () => {
		const root = legacyRoot();
		writeLegacy(
			root,
			"profile-tea.md",
			"type: profile\ntitle: tea\nsalience: 1\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\n",
			"jasmine",
		);
		writeLegacy(
			root,
			"procedure-deploy.md",
			"type: procedure\ntitle: deploy\nsalience: 0.7\ncreated: 2026-10-02T00:00:00.000Z\nupdated: 2026-10-02T00:00:00.000Z\n",
			"npm run check",
		);
		const report = inventoryMemory(root);
		expect(report.dryRun).toBe(true);
		expect(report.entries).toHaveLength(2);
		expect(report.entries.find((e) => e.title === "tea")?.destination).toBe("persona");
		expect(report.entries.find((e) => e.title === "deploy")?.destination).toBe("pending-review");
		expect(existsSync(join(root, "memory", "profile-tea.md"))).toBe(true);
	});

	test("migration preserves content and dates, separates pending review, and is re-entrant", () => {
		const root = legacyRoot();
		writeLegacy(
			root,
			"profile-tea.md",
			"type: profile\ntitle: tea\nsalience: 1\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\n",
			"jasmine body",
		);
		writeLegacy(
			root,
			"episode-outage.md",
			"type: episode\ntitle: outage night\nsalience: 0.5\ncreated: 2026-10-03T00:00:00.000Z\nupdated: 2026-10-03T00:00:00.000Z\nstatus: open\n",
			"database died",
		);
		const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
		const report = migrateMemoryLayout(root, state);
		expect(report.dryRun).toBe(false);
		expect(report.failures).toHaveLength(0);
		const personaFile = join(root, "memory", "persona", "profile-tea.md");
		expect(readFileSync(personaFile, "utf8")).toContain("jasmine body");
		const personaRecord = new MemoryChannel(join(root, "memory"), state).store({ scope: "persona" }).list(true)[0]!;
		expect(personaRecord.created.toISOString()).toBe("2026-10-01T00:00:00.000Z");
		// Work-context record with no recoverable project: pending, not in persona.
		expect(existsSync(join(root, "memory", "pending-review", "episode-outage.md"))).toBe(true);
		expect(new MemoryChannel(join(root, "memory"), state).store({ scope: "persona" }).list(true)).toHaveLength(1);
		expect(report.mapping["episode-outage.md"]).toContain("pending-review");
		// Re-running is a no-op with the same report.
		const again = migrateMemoryLayout(root, state);
		expect(again.completedAt).toBe(report.completedAt);
		expect(readMigrationManifest(root)?.completedAt).toBeTruthy();
	});

	test("interrupted migration resumes per file without duplicating", () => {
		const root = legacyRoot();
		writeLegacy(
			root,
			"profile-tea.md",
			"type: profile\ntitle: tea\nsalience: 1\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\n",
			"jasmine",
		);
		const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
		// Simulate a crash after the persona directory was created and the file moved.
		mkdirSync(join(root, "memory", "persona"), { recursive: true });
		const first = migrateMemoryLayout(root, state);
		expect(first.entries).toHaveLength(1);
		// No manifest yet: a resumed run must not fail on the already-moved file.
		const resumed = migrateMemoryLayout(root, state);
		expect(resumed.failures).toHaveLength(0);
		expect(existsSync(join(root, "memory", "persona", "profile-tea.md"))).toBe(true);
	});

	test("backup holds verified copies before anything moves", () => {
		const root = legacyRoot();
		writeLegacy(
			root,
			"profile-tea.md",
			"type: profile\ntitle: tea\nsalience: 1\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\n",
			"backup me",
		);
		const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
		const report = migrateMemoryLayout(root, state);
		expect(report.backupDir).toBeTruthy();
		expect(readFileSync(join(report.backupDir!, "memory", "profile-tea.md"), "utf8")).toContain("backup me");
	});

	test("migration never reads outside the product directory", () => {
		const root = legacyRoot();
		const outside = join(root, ".neko_mem");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "memory.md"), "private");
		const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
		inventoryMemory(root);
		migrateMemoryLayout(root, state);
		expect(readFileSync(join(outside, "memory.md"), "utf8")).toBe("private");
	});
});

describe("migration rollback", () => {
	test("rollback exports post-migration facts first, then restores the backup (G06)", () => {
		const root = legacyRoot();
		writeLegacy(
			root,
			"profile-tea.md",
			"type: profile\ntitle: tea\nsalience: 1\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\n",
			"jasmine",
		);
		const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
		const report = migrateMemoryLayout(root, state);
		// A new fact lands after the migration.
		new MemoryChannel(join(root, "memory"), state).write({
			type: "anchor",
			title: "post-migration fact",
			body: "accepted after cutover",
			source: "user",
			scope: { scope: "persona" },
		});
		const rollback = rollbackMigration(root, report.backupDir!);
		// The export preserves the new fact before the old tree is restored.
		expect(rollback.exportedRecords).toBe(2);
		const exported = JSON.parse(readFileSync(rollback.exportedPath, "utf8")) as {
			records: Array<{ content: string }>;
		};
		expect(exported.records.some((record) => record.content.includes("accepted after cutover"))).toBe(true);
		// The persona tree is back to the pre-migration single record.
		const restored = new MemoryChannel(join(root, "memory"), state).store({ scope: "persona" }).list(true);
		expect(restored.map((record) => record.title)).toEqual(["tea"]);
		// The manifest records the rollback; a rerun does not silently re-migrate.
		const manifest = readMigrationManifest(root);
		expect(manifest?.rolledBackAt).toBe(rollback.rolledBackAt);
		const again = migrateMemoryLayout(root, state);
		expect(again.rolledBackAt).toBe(rollback.rolledBackAt);
		expect(
			new MemoryChannel(join(root, "memory"), state)
				.store({ scope: "persona" })
				.list(true)
				.map((r) => r.title),
		).toEqual(["tea"]);
	});

	test("rollback refuses without a completed migration or an existing backup", () => {
		const root = legacyRoot();
		const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
		expect(() => rollbackMigration(root, join(root, "nowhere"))).toThrow(/No completed migration/);
		writeLegacy(
			root,
			"profile-one.md",
			"type: profile\ntitle: one\nsalience: 1\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\n",
			"body",
		);
		migrateMemoryLayout(root, state);
		expect(() => rollbackMigration(root, join(root, "nowhere"))).toThrow(/Backup directory missing/);
	});
});

describe("legacy schema v2 database", () => {
	test("opening a v2 database migrates rows to v3, admits scratch writes, and ignores memory_catalog receipts", () => {
		const root = legacyRoot();
		const dbFile = join(root, "runtime", "state.sqlite");
		const session = "legacy-session";

		// The memory tree a real v2 installation had beside the database: one
		// persona record and one project record, both already registered.
		const personaId = stableRecordId("profile", "tea");
		const personaRecord: MemoryRecord = {
			id: personaId,
			type: "profile",
			title: "tea",
			body: "jasmine, no sugar",
			salience: 1,
			created: new Date("2026-10-01T00:00:00.000Z"),
			updated: new Date("2026-10-01T00:00:00.000Z"),
			tags: [],
			version: 2,
		};
		const workDir = join(root, "work");
		mkdirSync(workDir, { recursive: true });
		const identity = resolveProjectIdentity(workDir);
		const projectScope = { scope: "project" as const, projectId: identity.projectId };
		const projectId = stableRecordId("procedure", "deploy");
		const projectRecord: MemoryRecord = {
			id: projectId,
			type: "procedure",
			title: "deploy",
			body: "npm run check",
			salience: 0.7,
			created: new Date("2026-10-02T00:00:00.000Z"),
			updated: new Date("2026-10-02T00:00:00.000Z"),
			tags: [],
			version: 2,
		};
		const personaPlanted = plantRecord(join(root, "memory", "persona"), personaRecord);
		const projectPlanted = plantRecord(join(root, "memory", "projects", identity.folder, "records"), projectRecord);

		// A hand-built v2 database: the old scope CHECK admits only
		// persona/project, and the snapshot-catalog receipts the legacy
		// delivery model left behind are still in context_receipts.
		mkdirSync(join(root, "runtime"), { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(dbFile);
		db.exec(`
		  CREATE TABLE schema_migrations (
		    version INTEGER PRIMARY KEY,
		    applied_at INTEGER NOT NULL
		  );
		  CREATE TABLE memory_records (
		    record_id TEXT NOT NULL,
		    scope TEXT NOT NULL CHECK (scope IN ('persona','project')),
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
		  CREATE TABLE scope_versions (
		    scope_key TEXT PRIMARY KEY,
		    version INTEGER NOT NULL
		  );
		  CREATE TABLE context_receipts (
		    session TEXT NOT NULL,
		    kind TEXT NOT NULL,
		    ref TEXT NOT NULL DEFAULT '',
		    version INTEGER NOT NULL,
		    time INTEGER NOT NULL,
		    PRIMARY KEY (session, kind, ref)
		  );
		`);
		db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(
			personaRecord.created.getTime(),
		);
		const insertRecord = db.prepare(
			`INSERT INTO memory_records (record_id, scope, project_id, owner, type, title, file, content_hash, version, status, occurred, created, updated, bytes)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		insertRecord.run(
			personaId,
			"persona",
			null,
			"persona",
			personaRecord.type,
			personaRecord.title,
			personaPlanted.file,
			hashText(personaPlanted.serialized),
			personaRecord.version ?? 1,
			null,
			null,
			personaRecord.created.getTime(),
			personaRecord.updated.getTime(),
			Buffer.byteLength(personaPlanted.serialized),
		);
		insertRecord.run(
			projectId,
			"project",
			identity.projectId,
			identity.projectId,
			projectRecord.type,
			projectRecord.title,
			projectPlanted.file,
			hashText(projectPlanted.serialized),
			projectRecord.version ?? 1,
			null,
			null,
			projectRecord.created.getTime(),
			projectRecord.updated.getTime(),
			Buffer.byteLength(projectPlanted.serialized),
		);
		db.prepare("INSERT INTO scope_versions (scope_key, version) VALUES ('persona', 1), (?, 1)").run(
			`project:${identity.projectId}`,
		);
		const insertCatalogReceipt = db.prepare(
			"INSERT INTO context_receipts (session, kind, ref, version, time) VALUES (?, 'memory_catalog', ?, 1, ?)",
		);
		insertCatalogReceipt.run(session, "persona", personaRecord.updated.getTime());
		insertCatalogReceipt.run(session, `project:${identity.projectId}`, projectRecord.updated.getTime());
		db.close();

		// Opening with the current build migrates in place: schema version 3
		// and a memory_records CHECK that now admits 'scratch'.
		const state = new RuntimeState(dbFile);
		const channel = new MemoryChannel(join(root, "memory"), state);
		const inspect = new DatabaseSync(dbFile);
		const table = inspect
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_records'")
			.get() as { sql: string };
		expect(table.sql).toContain("'scratch'");
		expect(
			(inspect.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number })
				.version,
		).toBe(5);
		inspect.close();

		// Both legacy rows survive the table rebuild with metadata intact.
		const personaRow = state.listMemoryRecords({ scope: "persona" })[0]!;
		expect(personaRow.recordId).toBe(personaId);
		expect(personaRow.title).toBe("tea");
		expect(personaRow.version).toBe(2);
		expect(personaRow.contentHash).toBe(hashText(personaPlanted.serialized));
		const projectRow = state.listMemoryRecords(projectScope)[0]!;
		expect(projectRow.recordId).toBe(projectId);
		expect(projectRow.title).toBe("deploy");
		expect(projectRow.version).toBe(2);
		expect(projectRow.owner).toBe(identity.projectId);

		// A scratch write through the rebuilt table succeeds (the old CHECK
		// would have rejected the insert outright).
		const pinned = channel.write({
			type: "anchor",
			title: "pinned fact",
			body: "durable but unassigned",
			source: "model",
			scope: { scope: "scratch" },
			originSessionId: "post-upgrade",
			originCwd: workDir,
		});
		expect(pinned.action).toBe("created");
		expect(state.getMemoryRecord({ scope: "scratch" }, pinned.recordId!)).toBeDefined();

		// The legacy memory_catalog receipts do not gate per-record delivery:
		// the session's first build is exactly one baseline carrying both
		// visible records — not silence, and not an "update" framing either.
		const first = buildMemoryDelivery({ sessionId: session, projectScope, channel });
		expect(first.sections.map((section) => section.split("\n")[0])).toEqual([
			"### Memory baseline: persona",
			`### Memory baseline: project ${identity.projectId.slice(0, 8)}`,
		]);
		expect(first.sections.join("\n")).toContain("jasmine, no sugar");
		expect(first.sections.join("\n")).toContain("npm run check");
		expect(first.receipts).toHaveLength(2);
		expect(first.tombstones).toHaveLength(0);
		expect(first.omitted).toHaveLength(0);

		// After committing the per-record receipts, an unchanged query
		// delivers nothing — no sections, no tombstones — while the legacy
		// catalog rows stay in place, untouched by the new model.
		for (const receipt of first.receipts)
			state.markReceipt(session, "memory_record", receipt.fingerprint, receipt.ref);
		const second = buildMemoryDelivery({ sessionId: session, projectScope, channel });
		expect(second.sections).toHaveLength(0);
		expect(second.receipts).toHaveLength(0);
		expect(second.tombstones).toHaveLength(0);
		expect(state.getReceipt(session, "memory_catalog", "persona")?.version).toBe(1);
		expect(state.getReceipt(session, "memory_catalog", `project:${identity.projectId}`)?.version).toBe(1);

		// v5: the rebuilt CHECK also admits 'toolbox' writes.
		const tool = channel.write({
			type: "procedure",
			title: "toolbox fact",
			body: "travels with the person",
			source: "model",
			scope: { scope: "toolbox" },
		});
		expect(tool.action).toBe("created");
		expect(state.getMemoryRecord({ scope: "toolbox" }, tool.recordId!)).toBeDefined();
	});
});
