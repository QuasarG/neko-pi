import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ActivityStore } from "../src/core/activity.ts";
import { MemoryChannel } from "../src/core/memory/channel.ts";
import { CONTINUITY_TTL_MS, ContinuityStore } from "../src/core/memory/continuity.ts";
import { resolveProjectIdentity } from "../src/core/runtime/identity.ts";
import { RuntimeState } from "../src/core/runtime/state-db.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function wardrobeOf(ids: string[]) {
	return { outfits: ids.map((id) => ({ id, name: id, description: id })) };
}

function setup(budgets?: { personaActive?: number; personaHistory?: number }) {
	const root = mkdtempSync(join(tmpdir(), "neko-complete-"));
	scratch.push(root);
	const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
	const channel = new MemoryChannel(join(root, "memory"), state, budgets ?? {});
	return { root, state, channel };
}

describe("runtime completions", () => {
	test("a tool-result event is known per session without skipping older unknowns (C04/C06)", () => {
		const { root, state } = setup();
		const dir = join(root, "repo");
		mkdirSync(dir, { recursive: true });
		const identity = resolveProjectIdentity(dir);
		state.ensureProject(identity);
		const persona = { scope: "persona" } as const;
		// s1's first message: cursor lands after its own query.
		state.appendActivity({ session: "s1", scope: persona, kind: "user_query", payload: "s1 q1", now: 1000 });
		// Event 13: another session's update s1 never saw.
		state.appendActivity({ session: "s2", scope: persona, kind: "memory_updated", payload: "s2 note", now: 1100 });
		// Event 14: s1's own memory write, whose tool result entered s1's history.
		const own = state.appendActivity({
			session: "s1",
			scope: persona,
			kind: "memory_updated",
			payload: "s1 own write",
			now: 1200,
		});
		state.markEventKnown("s1", own);
		// s1 still delivers 13, skips 14; the cursor never jumped past 13.
		const first = state.activitiesSince(1, null, 8000, state.knownEventSeqs("s1"));
		expect(first.events.map((event) => event.payload)).toEqual(["s2 note"]);
		// s2, which has no per-event receipt, still receives both if unseen.
		const second = state.activitiesSince(0, null, 8000, state.knownEventSeqs("s2"));
		expect(second.events.map((event) => event.payload)).toEqual(["s1 q1", "s2 note", "s1 own write"]);
	});

	test("managed write/edit paths resolve to their scope (persona, project, outside)", () => {
		const { root, state, channel } = setup();
		const dir = join(root, "repo");
		mkdirSync(dir, { recursive: true });
		const identity = resolveProjectIdentity(dir);
		state.ensureProject(identity);
		const projectScope = { scope: "project" as const, projectId: identity.projectId };
		channel.write({ type: "anchor", title: "seed", body: "x", source: "model", scope: projectScope });
		const personaDir = channel.store({ scope: "persona" }).dir;
		expect(channel.scopeForPath(join(personaDir, "note.md"))).toEqual({ scope: "persona" });
		const recordsDir = channel.store(projectScope).dir;
		expect(channel.scopeForPath(join(recordsDir, "note.md"))).toEqual(projectScope);
		expect(channel.scopeForPath(join(recordsDir, "sub", "note.md"))).toEqual(projectScope);
		expect(channel.scopeForPath(join(root, "outside.md"))).toBeUndefined();
		expect(channel.scopeForPath(join(personaDir, "..", "escape.md"))).toBeUndefined();
	});

	test("scope collection budget fails honestly instead of truncating (M10)", () => {
		const { channel } = setup({ personaActive: 100 });
		const scope = { scope: "persona" } as const;
		const ok = channel.write({ type: "anchor", title: "fits", body: "a".repeat(60), source: "user", scope });
		expect(ok.action).toBe("created");
		const over = channel.write({ type: "anchor", title: "too big", body: "b".repeat(60), source: "user", scope });
		expect(over.action).toBe("rejected");
		expect(over.note).toContain("not saved");
		expect(channel.store(scope).list(true)).toHaveLength(1);
		// Consolidating below the ceiling lets the write through again.
		const merged = channel.write({ type: "anchor", title: "fits", body: "c".repeat(10), source: "user", scope });
		expect(merged.action).toBe("merged");
	});

	test("history ceiling pauses archival with a note, never deletes or fakes success (M10)", () => {
		const { channel } = setup({ personaHistory: 1 });
		const scope = { scope: "persona" } as const;
		channel.write({ type: "anchor", title: "first", body: "v1", source: "user", scope });
		// First merge creates a history copy; from then on the ceiling is over.
		const archived = channel.write({ type: "anchor", title: "first", body: "v2", source: "user", scope });
		expect(archived.action).toBe("merged");
		expect(archived.note).toBeUndefined();
		const paused = channel.write({ type: "anchor", title: "first", body: "v3", source: "user", scope });
		expect(paused.action).toBe("merged");
		expect(paused.note).toContain("history budget reached");
		expect(channel.store(scope).list(true)[0]!.body).toBe("v3");
		// The active record still saved; the history holds the one archived copy.
		const historyFiles = readdirSync(join(channel.store(scope).dir, "history"));
		expect(historyFiles).toHaveLength(1);
	});

	test("activity sequence never regresses on clock setback; message rows keep frozen times (Q11)", () => {
		const { state } = setup();
		const seq1 = state.appendActivity({
			session: "s",
			scope: { scope: "persona" },
			kind: "user_query",
			payload: "early",
			now: 5000,
		});
		const seq2 = state.appendActivity({
			session: "s",
			scope: { scope: "persona" },
			kind: "user_query",
			payload: "after setback",
			now: 1000,
		});
		expect(seq2).toBeGreaterThan(seq1);
		const identity = resolveProjectIdentity("/nowhere/repo");
		state.ensureProject(identity);
		state.enqueueMessage({
			messageId: "msg_tz",
			session: "s",
			projectId: identity.projectId,
			received: 5000,
			timeZone: "Asia/Shanghai",
			text: "old",
			snapshot: "{}",
			personaVersion: 0,
			projectVersion: 0,
			activityThrough: 0,
			state: "done",
			retryOf: null,
		});
		const row = state.getMessage("msg_tz")!;
		expect(row.received).toBe(5000);
		expect(row.timeZone).toBe("Asia/Shanghai");
	});

	test("wardrobe config changes reach new messages while old history stays fixed (R05)", () => {
		const { root, state } = setup();
		const activity = new ActivityStore(state);
		const dir = join(root, "repo");
		const first = activity.prepare("s1", dir, "q1", wardrobeOf(["a", "b"]), 1000);
		const oldOutfit = first.context.outfit!;
		expect(oldOutfit).toBeTruthy();
		// Configuration changes to a brand-new set: the next message reflects it.
		const second = activity.prepare("s2", dir, "q2", wardrobeOf(["c"]), 1000 + 10);
		expect(second.context.outfit?.id).toBe("c");
		// Already-recorded history (activities, frozen snapshots) is not recomputed.
		const events = state.activitiesSince(0, null, 10000).events;
		const outfitEvent = events.find((event) => event.kind === "outfit_changed");
		expect(outfitEvent?.payload).toBe(oldOutfit.name);
		const frozen = JSON.stringify(first.context);
		expect(frozen).toContain(oldOutfit.id);
	});

	test("continuity expiry is per scope and never crosses scopes (R06)", () => {
		const { root, state } = setup();
		const persona = new ContinuityStore(state, { scope: "persona" });
		const projectId = resolveProjectIdentity(join(root, "repo")).projectId;
		const project = new ContinuityStore(state, { scope: "project", projectId });
		const claim = persona.claim("s1");
		expect(persona.commit(claim, "global stage: choosing tea")).toBe(true);
		// Project scope stays empty; persona content does not leak into it.
		expect(project.context()).toBe("");
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + CONTINUITY_TTL_MS + 1);
		// Expired persona stage is not treated as currently happening.
		expect(persona.context()).toBe("");
		vi.useRealTimers();
		// A fresh write after expiry becomes current again, still scoped.
		const renewed = persona.claim("s2");
		expect(persona.commit(renewed, "new stage")).toBe(true);
		expect(persona.context()).toContain("new stage");
		expect(project.context()).toBe("");
	});

	test("whisper merges keep their subjective nature and never gain promise status (M07)", () => {
		const { channel } = setup();
		const scope = { scope: "persona" } as const;
		channel.write({ type: "whisper", title: "想讨一次奖励", body: "希望主人夸夸", source: "model", scope });
		const merged = channel.write({
			type: "whisper",
			title: "想讨一次奖励",
			body: "还是想被抱着夸",
			source: "model",
			scope,
		});
		expect(merged.action).toBe("merged");
		const record = channel.store(scope).list(true)[0]!;
		expect(record.type).toBe("whisper");
		expect(record.status).toBeUndefined();
		expect(record.body).toBe("还是想被抱着夸");
		const historyDir = join(channel.store(scope).dir, "history");
		expect(readdirSync(historyDir).length).toBe(1);
		// Subjective wording is preserved; it never becomes a user commitment.
		expect(channel.store(scope).recall("奖励")[0]!.record.type).toBe("whisper");
	});

	test("a failed consolidation leaves every active record in place (M11)", () => {
		const { channel } = setup();
		const scope = { scope: "persona" } as const;
		channel.write({ type: "episode", title: "sprint one", body: "kept", source: "model", scope });
		channel.write({ type: "episode", title: "sprint two", body: "also kept", source: "model", scope });
		const store = channel.store(scope);
		// Age both episodes past the decay floor so consolidation must archive.
		const stale = new Date(Date.now() - 75 * 86_400_000).toISOString();
		for (const record of store.list(true)) {
			const file = join(store.dir, record.file!);
			writeFileSync(file, readFileSync(file, "utf8").replace(/^updated: .*$/m, `updated: ${stale}`));
		}
		store.list(true);
		// Block the archive directory so consolidation fails before moving anything.
		writeFileSync(join(store.dir, "archive"), "not a directory");
		expect(() => store.consolidate()).toThrow();
		expect(
			store
				.list(true)
				.map((r) => r.title)
				.sort(),
		).toEqual(["sprint one", "sprint two"]);
	});

	test("a corrupt or future-schema database fails loudly without being overwritten (G04)", () => {
		const root = mkdtempSync(join(tmpdir(), "neko-g04-"));
		scratch.push(root);
		const corrupt = join(root, "corrupt.sqlite");
		writeFileSync(corrupt, "definitely not sqlite");
		const bytesBefore = readFileSync(corrupt);
		expect(() => new RuntimeState(corrupt)).toThrow(/unusable|refusing/i);
		expect(readFileSync(corrupt).equals(bytesBefore)).toBe(true);
		// A database from a newer program is refused with an upgrade hint.
		const future = join(root, "future.sqlite");
		const seed = new RuntimeState(future);
		seed.close();
		const raw = new DatabaseSync(future);
		raw.exec("INSERT INTO schema_migrations (version, applied_at) VALUES (999, 1)");
		raw.close();
		expect(() => new RuntimeState(future)).toThrow(/newer than this build supports/);
	});

	test("legacy runtime files coexist untouched beside the new store (G08)", () => {
		const { root, state, channel } = setup();
		const legacy = join(root, "runtime", "activity.json");
		mkdirSync(join(root, "runtime"), { recursive: true });
		writeFileSync(legacy, JSON.stringify({ version: 1, legacy: true }));
		const scope = { scope: "persona" } as const;
		channel.write({ type: "anchor", title: "new program fact", body: "x", source: "user", scope });
		const activity = new ActivityStore(state);
		activity.prepare("s1", join(root, "repo"), "hello", { outfits: [] }, 1000);
		// The old program's file is never read, rewritten, or deleted.
		expect(JSON.parse(readFileSync(legacy, "utf8"))).toEqual({ version: 1, legacy: true });
		// An old-program flat write into the legacy location stays harmless:
		// invisible to scopes, never mixed into persona.
		writeFileSync(join(root, "memory", "old-style.md"), "---\ntype: anchor\ntitle: old\n---\nlegacy body");
		expect(
			channel
				.store(scope)
				.list(true)
				.map((r) => r.title),
		).toEqual(["new program fact"]);
	});

	test("promise status transitions keep old open promises alive (M06)", () => {
		const { channel } = setup();
		const scope = { scope: "persona" } as const;
		channel.write({
			type: "promise",
			title: "review checklist",
			body: "promise to review",
			source: "model",
			scope,
			status: "open",
		});
		channel.write({
			type: "promise",
			title: "ship release",
			body: "promise to ship",
			source: "model",
			scope,
			status: "open",
		});
		const fulfilled = channel.write({
			type: "promise",
			title: "ship release",
			body: "shipped",
			source: "user",
			scope,
			status: "fulfilled",
		});
		expect(fulfilled.action).toBe("merged");
		const records = channel.store(scope).list(true);
		expect(records.find((r) => r.title === "ship release")?.status).toBe("fulfilled");
		const stillOpen = records.find((r) => r.title === "review checklist");
		expect(stillOpen?.status).toBe("open");
		// Consolidation must not retire the still-open promise as "too old".
		channel.store(scope).consolidate();
		expect(
			channel
				.store(scope)
				.list(true)
				.find((r) => r.title === "review checklist")?.status,
		).toBe("open");
	});
});
