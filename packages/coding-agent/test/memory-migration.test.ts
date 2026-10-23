import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryChannel } from "../src/core/memory/channel.ts";
import {
	inventoryMemory,
	migrateMemoryLayout,
	readMigrationManifest,
	rollbackMigration,
} from "../src/core/memory/migrate.ts";
import { RuntimeState } from "../src/core/runtime/state-db.ts";

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
