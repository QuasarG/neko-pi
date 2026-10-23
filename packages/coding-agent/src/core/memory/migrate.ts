/**
 * One-time migration of the product's own legacy memory layout (flat
 * `memory/*.md`) into the scoped layout (`memory/persona/` plus
 * `memory/pending-review/`). Only `~/.neko_pi` contents are touched; other
 * agents' directories and external AGENTS.md are never read or modified.
 *
 * Deterministic destination rule: personal record types (profile, whisper,
 * promise) are persona scope. Work-context types (anchor, episode,
 * procedure) have no recoverable project, so they move to pending-review —
 * visible in the report, excluded from catalogs and injection until the user
 * assigns them. Nothing is guessed from the current working directory.
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { MemoryScope } from "../runtime/identity.ts";
import type { RuntimeState } from "../runtime/state-db.ts";
import { readRecordFile } from "./store.ts";

const PERSONAL_TYPES = new Set(["profile", "whisper", "promise"]);

export interface MigrationEntry {
	file: string;
	type: string;
	title: string;
	bytes: number;
	hash: string;
	destination: "persona" | "pending-review";
}

export interface MigrationReport {
	completedAt: number | null;
	dryRun: boolean;
	entries: MigrationEntry[];
	pendingReview: string[];
	mapping: Record<string, string>;
	backupDir: string | null;
	failures: string[];
	/** Set when a controlled rollback restored the backup (export kept first). */
	rolledBackAt?: number;
	rollbackExport?: string;
}

function legacyMemoryDir(agentRoot: string): string {
	return join(agentRoot, "memory");
}

function manifestPath(agentRoot: string): string {
	return join(agentRoot, "migrations", "memory-migration.json");
}

function hashFile(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function readMigrationManifest(agentRoot = getAgentDir()): MigrationReport | undefined {
	const file = manifestPath(agentRoot);
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as MigrationReport;
	} catch {
		return undefined;
	}
}

/** Inventory without touching anything: what exists, where it would go. */
export function inventoryMemory(agentRoot = getAgentDir()): MigrationReport {
	const legacy = legacyMemoryDir(agentRoot);
	const entries: MigrationEntry[] = [];
	const failures: string[] = [];
	if (existsSync(legacy)) {
		for (const name of readdirSync(legacy)) {
			if (!name.endsWith(".md")) continue;
			const file = join(legacy, name);
			try {
				const record = readRecordFile(file);
				const raw = readFileSync(file);
				entries.push({
					file: name,
					type: record?.type ?? "unknown",
					title: record?.title ?? name,
					bytes: raw.byteLength,
					hash: createHash("sha256").update(raw).digest("hex"),
					destination: record && PERSONAL_TYPES.has(record.type) ? "persona" : "pending-review",
				});
			} catch (error) {
				failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return {
		completedAt: null,
		dryRun: true,
		entries,
		pendingReview: entries.filter((entry) => entry.destination === "pending-review").map((entry) => entry.file),
		mapping: {},
		backupDir: null,
		failures,
	};
}

function moveInto(source: string, targetDir: string, name: string): string {
	mkdirSync(targetDir, { recursive: true, mode: 0o700 });
	const target = join(targetDir, name);
	if (existsSync(target)) {
		// Resume after interruption: identical content means already moved.
		if (hashFile(target) === hashFile(source)) return target;
		throw new Error(`Target already exists with different content: ${target}`);
	}
	renameSync(source, target);
	return target;
}

/**
 * Run the migration. Safe to call repeatedly: a completed manifest short
 * circuits, and per-file moves verify content before skipping.
 */
export function migrateMemoryLayout(agentRoot = getAgentDir(), state: RuntimeState, dryRun = false): MigrationReport {
	const existing = readMigrationManifest(agentRoot);
	if (existing?.completedAt) return existing;
	const report = inventoryMemory(agentRoot);
	const legacyRoot = legacyMemoryDir(agentRoot);
	const hasLegacySubtrees = existsSync(join(legacyRoot, "history")) || existsSync(join(legacyRoot, "archive"));
	// Flat records OR legacy subdirectories (history/, archive/) both count as
	// migration work; an archive-only layout must not short-circuit.
	if (dryRun || (report.entries.length === 0 && !hasLegacySubtrees)) return report;

	report.dryRun = false;
	const legacy = legacyMemoryDir(agentRoot);
	const timestamp = Date.now();
	const backupDir = join(agentRoot, "migrations", `backup-${timestamp}`);
	const backupMemory = join(backupDir, "memory");
	mkdirSync(backupMemory, { recursive: true, mode: 0o700 });

	// Back up the whole legacy tree first, verifying every copy byte-for-byte.
	const backupFile = (relative: string) => {
		const source = join(legacy, relative);
		if (!existsSync(source)) return;
		const target = join(backupMemory, relative);
		mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
		copyFileSync(source, target);
		if (statSync(target).size !== statSync(source).size || hashFile(target) !== hashFile(source)) {
			throw new Error(`Backup verification failed for ${relative}`);
		}
	};
	for (const entry of readdirSync(legacy, { withFileTypes: true })) {
		if (entry.isFile()) backupFile(entry.name);
	}
	for (const sub of ["history", "archive"]) {
		const dir = join(legacy, sub);
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isFile()) backupFile(join(sub, entry.name));
		}
	}
	report.backupDir = backupDir;

	const personaDir = join(agentRoot, "memory", "persona");
	const pendingDir = join(agentRoot, "memory", "pending-review");
	const personaScope: MemoryScope = { scope: "persona" };
	const moved: Array<{ entry: MigrationEntry; target: string }> = [];
	for (const entry of report.entries) {
		const targetDir = entry.destination === "persona" ? personaDir : pendingDir;
		const target = moveInto(join(legacy, entry.file), targetDir, entry.file);
		report.mapping[entry.file] = target;
		if (entry.destination === "persona") moved.push({ entry, target });
	}
	// Legacy history and archive copies follow their scope's records.
	const legacyHistory = join(legacyMemoryDir(agentRoot), "history");
	if (existsSync(legacyHistory)) {
		for (const name of readdirSync(legacyHistory))
			moveInto(join(legacyHistory, name), join(personaDir, "history"), name);
	}
	// Legacy archives are archived project-era work with no recoverable
	// owner: they wait in pending-review beside the other unconfirmed records,
	// never inside persona where global recall would surface them (P1).
	const legacyArchive = join(legacyMemoryDir(agentRoot), "archive");
	if (existsSync(legacyArchive)) {
		for (const name of readdirSync(legacyArchive)) {
			const target = moveInto(join(legacyArchive, name), join(pendingDir, "archive"), name);
			report.mapping[`archive/${name}`] = target;
		}
	}

	// Register migrated persona records with stable IDs and their real bytes.
	for (const { entry, target } of moved) {
		let record = readRecordFile(target);
		if (!record) {
			report.failures.push(`${entry.file}: unreadable after move`);
			continue;
		}
		if (!record.id) {
			// Old files predate the id field: stamp it into the frontmatter so
			// later updates of the same topic bind the same stable id (P1).
			const stampedId = `rec_${entry.hash.slice(0, 12)}`;
			const raw = readFileSync(target, "utf8");
			const frontmatterEnd = raw.indexOf("\n---", 3);
			if (frontmatterEnd !== -1) {
				const stamped = `---\nid: ${stampedId}${raw.slice(3)}`;
				writeFileSync(target, stamped, { mode: 0o600 });
				record = readRecordFile(target) ?? { ...record, id: stampedId };
			}
		}
		state.registerMemoryWrite({
			scope: personaScope,
			recordId: record.id ?? `rec_${entry.hash.slice(0, 12)}`,
			type: record.type,
			title: record.title,
			file: entry.file,
			content: readFileSync(target, "utf8"),
			status: record.status ?? null,
			occurred: null,
			created: record.created.getTime(),
			change: "imported",
		});
	}

	report.completedAt = Date.now();
	const manifest = manifestPath(agentRoot);
	mkdirSync(dirname(manifest), { recursive: true, mode: 0o700 });
	const tmp = `${manifest}.tmp`;
	writeFileSync(tmp, JSON.stringify(report, null, "\t"), { mode: 0o600 });
	renameSync(tmp, manifest);
	return report;
}

export interface RollbackResult {
	/** Export file holding every current persona record before restore (G06). */
	exportedPath: string;
	exportedRecords: number;
	restoredFiles: number;
	rolledBackAt: number;
}

/**
 * Controlled rollback of the scoped-layout migration. New facts written after
 * the migration are exported first — nothing accepted after migration is lost
 * by going back. The manifest records the rollback so a rerun does not
 * re-migrate silently (G06/§16.3).
 */
export function rollbackMigration(agentRoot: string, backupDir: string): RollbackResult {
	const manifest = readMigrationManifest(agentRoot);
	if (!manifest?.completedAt) throw new Error("No completed migration to roll back");
	if (!existsSync(backupDir)) throw new Error(`Backup directory missing: ${backupDir}`);
	const personaDir = join(agentRoot, "memory", "persona");
	const exported: Array<{ file: string; content: string }> = [];
	if (existsSync(personaDir)) {
		for (const name of readdirSync(personaDir)) {
			if (!name.endsWith(".md")) continue;
			exported.push({ file: name, content: readFileSync(join(personaDir, name), "utf8") });
		}
	}
	const rolledBackAt = Date.now();
	const exportedPath = join(agentRoot, "migrations", `rollback-export-${rolledBackAt}.json`);
	writeFileSync(
		exportedPath,
		JSON.stringify(
			{ exportedAt: rolledBackAt, reason: "pre-rollback export of post-migration facts", records: exported },
			null,
			"\t",
		),
		{ mode: 0o600 },
	);

	// Restore the whole persona tree — including history/ and archive/
	// directories — from the verified backup (recursive, not file-by-file).
	let restoredFiles = 0;
	rmSync(personaDir, { recursive: true, force: true });
	const backupMemory = join(backupDir, "memory");
	cpSync(backupMemory, personaDir, { recursive: true });
	restoredFiles = readdirSync(personaDir).length;
	manifest.rolledBackAt = rolledBackAt;
	manifest.rollbackExport = exportedPath;
	writeFileSync(manifestPath(agentRoot), JSON.stringify(manifest, null, "\t"), { mode: 0o600 });
	return { exportedPath, exportedRecords: exported.length, restoredFiles, rolledBackAt };
}
