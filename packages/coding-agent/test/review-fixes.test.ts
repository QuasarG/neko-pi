import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getMemoryChannel, MemoryChannel } from "../src/core/memory/channel.ts";
import { ContinuityStore } from "../src/core/memory/continuity.ts";
import { migrateMemoryLayout, rollbackMigration } from "../src/core/memory/migrate.ts";

import { resolveProjectIdentity } from "../src/core/runtime/identity.ts";
import { RuntimeState } from "../src/core/runtime/state-db.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "neko-fix-"));
	scratch.push(root);
	const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
	const channel = new MemoryChannel(join(root, "memory"), state);
	return { root, state, channel };
}

function project(state: RuntimeState, root: string, name: string) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const identity = resolveProjectIdentity(dir);
	state.ensureProject(identity);
	return identity;
}

describe("review fixes", () => {
	test("P1-1: explicit string scope 'project' lands in the project store, not persona", () => {
		const { root, state, channel } = setup();
		const identity = project(state, root, "repo");
		const scope = channel.resolveScope({ scope: "project", type: "anchor", cwd: join(root, "repo") });
		expect(scope).toEqual({ scope: "project", projectId: identity.projectId });
		channel.write({ type: "anchor", title: "架构决定", body: "project fact", source: "model", scope });
		expect(channel.store({ scope: "persona" }).list(true)).toHaveLength(0);
		const projectRecords = channel.store(scope).list(true);
		expect(projectRecords.map((r) => r.title)).toEqual(["架构决定"]);
		expect(channel.resolveScope({ scope: "persona", type: "anchor", cwd: join(root, "repo") })).toEqual({
			scope: "persona",
		});
	});

	test("P1-2: same topic in two projects keeps both metadata rows (owner key)", () => {
		const { root, state, channel } = setup();
		const a = project(state, root, "alpha");
		const b = project(state, root, "beta");
		channel.write({
			type: "procedure",
			title: "构建流程",
			body: "alpha steps",
			source: "model",
			scope: { scope: "project", projectId: a.projectId },
		});
		channel.write({
			type: "procedure",
			title: "构建流程",
			body: "beta steps",
			source: "model",
			scope: { scope: "project", projectId: b.projectId },
		});
		const recordId = `rec_${hashOf("procedure", "构建流程")}`;
		const rowA = state.getMemoryRecord({ scope: "project", projectId: a.projectId }, recordId);
		const rowB = state.getMemoryRecord({ scope: "project", projectId: b.projectId }, recordId);
		expect(rowA?.title).toBe("构建流程");
		expect(rowB?.title).toBe("构建流程");
		// Both file bodies survive; neither project's record was overwritten.
		expect(channel.store({ scope: "project", projectId: a.projectId }).list(true)[0]!.body).toBe("alpha steps");
		expect(channel.store({ scope: "project", projectId: b.projectId }).list(true)[0]!.body).toBe("beta steps");
		expect(state.listMemoryRecords({ scope: "project", projectId: a.projectId })).toHaveLength(1);
		expect(state.listMemoryRecords({ scope: "project", projectId: b.projectId })).toHaveLength(1);

		function hashOf(type: string, title: string): string {
			// stableRecordId: sha256(`${type}:${title}`) first 12 hex chars.
			return createHash("sha256").update(`${type}:${title}`).digest("hex").slice(0, 12);
		}
	});

	test("P1-3: a hand edit bumps the authoritative version; stale expectedVersion conflicts", async () => {
		const { channel } = setup();
		const scope = { scope: "persona" } as const;
		channel.write({ type: "anchor", title: "fact", body: "original", source: "user", scope });
		// The writer last saw version 1 (from the file).
		const seen = channel.store(scope).list(true)[0]!.version!;
		// A hand edit re-registers through the same pipeline: DB now at v2,
		// while the file's frontmatter still shows v1. Freshly written files
		// count as mid-write; let it settle first.
		const file = join(channel.store(scope).dir, channel.store(scope).list(true)[0]!.file!);
		writeFileSync(file, readFileSync(file, "utf8").replace("original", "hand-edited"));
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		channel.syncExternalChanges(scope);
		expect(channel.store(scope).list(true)[0]!.version).toBe(1); // file still v1
		const stale = channel.write({
			type: "anchor",
			title: "fact",
			body: "stale overwrite",
			source: "user",
			scope,
			expectedVersion: seen,
		});
		expect(stale.action).toBe("conflict");
		expect(channel.store(scope).list(true)[0]!.body).toBe("hand-edited");
		// Presenting the current DB version succeeds and continues numbering.
		const dbRow = channel.stateRef.getMemoryRecord(scope, channel.store(scope).list(true)[0]!.id!);
		const fresh = channel.write({
			type: "anchor",
			title: "fact",
			body: "fresh",
			source: "user",
			scope,
			expectedVersion: dbRow!.version,
		});
		expect(fresh.action).toBe("merged");
		expect(fresh.version).toBe(dbRow!.version + 1);
	});

	test("P1-4: opening the channel migrates a legacy layout automatically", () => {
		const root = mkdtempSync(join(tmpdir(), "neko-mig-"));
		scratch.push(root);
		vi.stubEnv("NEKO_PI_HOME", root);
		mkdirSync(join(root, "memory"), { recursive: true });
		writeFileSync(
			join(root, "memory", "profile-tea.md"),
			"---\ntype: profile\ntitle: tea\nsalience: 1\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\n---\n\njasmine\n",
		);
		// First use of the default root runs the migration; the persona store
		// reads the migrated record instead of appearing empty.
		const channel = getMemoryChannel(join(root, "memory"));
		const titles = channel
			.store({ scope: "persona" })
			.list(true)
			.map((record) => record.title);
		expect(titles).toEqual(["tea"]);
	});

	test("P1-7: rollback restores history/ and archive/ directories recursively", () => {
		const root = mkdtempSync(join(tmpdir(), "neko-rb-"));
		scratch.push(root);
		mkdirSync(join(root, "memory"), { recursive: true });
		writeFileSync(
			join(root, "memory", "profile-tea.md"),
			"---\ntype: profile\ntitle: tea\nsalience: 1\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\n---\n\njasmine\n",
		);
		const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
		const report = migrateMemoryLayout(root, state);
		// Post-migration history copies exist; rollback must restore them too.
		const historyDir = join(root, "memory", "persona", "history");
		mkdirSync(historyDir, { recursive: true });
		writeFileSync(join(historyDir, "old.md"), "history copy");
		const rollback = rollbackMigration(root, report.backupDir!);
		expect(rollback.restoredFiles).toBeGreaterThanOrEqual(1);
		// The restored tree keeps the record body.
		expect(existsSync(join(root, "memory", "persona", "profile-tea.md"))).toBe(true);
		expect(readFileSync(join(root, "memory", "persona", "profile-tea.md"), "utf8")).toContain("jasmine");
	});

	test("P2-9: claiming an expired continuity does not resurrect it", () => {
		const { state } = setup();
		const persona = new ContinuityStore(state, { scope: "persona" });
		const claim = persona.claim("s1");
		expect(persona.commit(claim, "stage one")).toBe(true);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
		// A new turn claims first — the old snapshot must stay expired.
		persona.claim("s2");
		expect(persona.context()).toBe("");
		vi.useRealTimers();
	});
});

describe("review fixes, round two", () => {
	test("P1-C: migrated legacy files carry ids; updating the same topic binds cleanly", () => {
		const root = mkdtempSync(join(tmpdir(), "neko-mid-"));
		scratch.push(root);
		mkdirSync(join(root, "memory"), { recursive: true });
		// A legacy record with NO id line in its frontmatter.
		writeFileSync(
			join(root, "memory", "profile-old.md"),
			"---\ntype: profile\ntitle: old times\nsalience: 1\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\n---\n\nfirst body\n",
		);
		const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
		const report = migrateMemoryLayout(root, state);
		expect(report.failures).toHaveLength(0);
		const channel = new MemoryChannel(join(root, "memory"), state);
		const stored = channel.store({ scope: "persona" }).list(true)[0]!;
		expect(stored.id).toMatch(/^rec_/);
		expect(readFileSync(join(channel.store({ scope: "persona" }).dir, stored.file!), "utf8")).toContain(
			`id: ${stored.id}`,
		);
		// Updating the same topic merges and re-registers without bind errors.
		const updated = channel.write({
			type: "profile",
			title: "old times",
			body: "second body",
			source: "user",
			scope: { scope: "persona" },
		});
		expect(updated.action).toBe("merged");
		expect(updated.recordId).toBe(stored.id);
		expect(channel.store({ scope: "persona" }).list(true)[0]!.body).toBe("second body");
	});

	test("P1-D: legacy archives wait in pending-review, never global persona", () => {
		const root = mkdtempSync(join(tmpdir(), "neko-arc-"));
		scratch.push(root);
		mkdirSync(join(root, "memory", "archive"), { recursive: true });
		writeFileSync(
			join(root, "memory", "archive", "episode-old-project.md"),
			"---\ntype: episode\ntitle: project outage night\nsalience: 0.5\ncreated: 2026-10-02T00:00:00.000Z\nupdated: 2026-10-02T00:00:00.000Z\n---\n\nlegacy project detail\n",
		);
		const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
		const report = migrateMemoryLayout(root, state);
		expect(report.mapping["archive/episode-old-project.md"]).toContain("pending-review");
		const personaStore = new MemoryChannel(join(root, "memory"), state).store({ scope: "persona" });
		// The archived project memory is not globally recallable from persona.
		expect(personaStore.recall("project outage night")).toHaveLength(0);
		expect(personaStore.list(true)).toHaveLength(0);
	});

	test("P1-E: an editor edit without any sync still cannot be overwritten by a stale writer", async () => {
		const { channel } = setup();
		const scope = { scope: "persona" } as const;
		channel.write({ type: "anchor", title: "guarded", body: "v1", source: "user", scope });
		const store = channel.store(scope);
		const seenVersion = store.list(true)[0]!.version!;
		// Direct editor change — NO syncExternalChanges call anywhere. Let it
		// settle past the mid-write window so the drift check inside write()
		// sees it.
		const file = join(store.dir, store.list(true)[0]!.file!);
		writeFileSync(file, readFileSync(file, "utf8").replace("v1", "EDITOR TRUTH"));
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		// A writer holding the pre-edit version must conflict, not overwrite.
		const stale = channel.write({
			type: "anchor",
			title: "guarded",
			body: "stale v2",
			source: "user",
			scope,
			expectedVersion: seenVersion,
		});
		expect(stale.action).toBe("conflict");
		expect(store.list(true)[0]!.body).toBe("EDITOR TRUTH");
		// A writer presenting the now-authoritative version succeeds.
		const row = channel.stateRef.getMemoryRecord(scope, store.list(true)[0]!.id!);
		const fresh = channel.write({
			type: "anchor",
			title: "guarded",
			body: "fresh v3",
			source: "user",
			scope,
			expectedVersion: row!.version,
		});
		expect(fresh.action).toBe("merged");
		expect(store.list(true)[0]!.body).toBe("fresh v3");
	});
});

describe("review fixes, round three", () => {
	test("P1: a deleted record cannot be resurrected by a stale expectedVersion", () => {
		const { channel } = setup();
		const scope = { scope: "persona" } as const;
		channel.write({ type: "anchor", title: "doomed", body: "v1", source: "user", scope });
		const record = channel.store(scope).list(true)[0]!;
		const seen = record.version!;
		// Delete through the managed pipeline: file gone, row gone, tombstone kept.
		channel.stateRef.deleteMemoryRecord(scope, record.id!);

		rmSync(join(channel.store(scope).dir, record.file!));
		channel.syncExternalChanges(scope);
		expect(channel.store(scope).list(true)).toHaveLength(0);
		// An old session holding v1 must conflict, not silently recreate.
		const stale = channel.write({
			type: "anchor",
			title: "doomed",
			body: "resurrected",
			source: "user",
			scope,
			expectedVersion: seen,
		});
		expect(stale.action).toBe("conflict");
		expect(stale.note).toContain("deleted");
		expect(channel.store(scope).list(true)).toHaveLength(0);
		// Migrated records keep hash-derived ids the recomputation can't find:
		// deletion must guard them identically (review round 4).
		const migRoot = mkdtempSync(join(tmpdir(), "neko-mig4-"));
		scratch.push(migRoot);
		mkdirSync(join(migRoot, "memory"), { recursive: true });
		writeFileSync(
			join(migRoot, "memory", "anchor-migrated.md"),
			"---\ntype: profile\ntitle: migrated ghost\nsalience: 1\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\n---\n\nold world\n",
		);
		const migState = new RuntimeState(join(migRoot, "runtime", "state.sqlite"));
		const report = migrateMemoryLayout(migRoot, migState);
		expect(report.failures).toHaveLength(0);
		const migChannel = new MemoryChannel(join(migRoot, "memory"), migState);
		const migrated = migChannel.store({ scope: "persona" }).list(true)[0]!;
		// Hash-derived id (not the type:title recomputation).
		expect(migrated.id).toMatch(/^rec_[0-9a-f]{12}$/);
		migChannel.stateRef.deleteMemoryRecord({ scope: "persona" }, migrated.id!);
		rmSync(join(migChannel.store({ scope: "persona" }).dir, migrated.file!));
		migChannel.syncExternalChanges({ scope: "persona" });
		const ghost = migChannel.write({
			type: "profile",
			title: "migrated ghost",
			body: "back from the dead",
			source: "user",
			scope: { scope: "persona" },
			expectedVersion: 1,
		});
		expect(ghost.action).toBe("conflict");
		expect(migChannel.store({ scope: "persona" }).list(true)).toHaveLength(0);
		// A deliberate recreation (no expectedVersion) still works.
		const reborn = channel.write({ type: "anchor", title: "doomed", body: "v2 fresh", source: "user", scope });
		expect(reborn.action).toBe("created");
		expect(channel.store(scope).list(true)[0]!.body).toBe("v2 fresh");
	});
});
