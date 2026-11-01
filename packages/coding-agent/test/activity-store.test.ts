import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	ACTIVITY_BUDGET_BYTES,
	type ActivityEvent,
	ActivityStore,
	OUTFIT_IDLE_MS,
	summarizeActivityEvents,
} from "../src/core/activity.ts";
import { resolveProjectIdentity } from "../src/core/runtime/identity.ts";
import { RuntimeState } from "../src/core/runtime/state-db.ts";
import type { Wardrobe } from "../src/core/wardrobe.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "neko-activity-"));
	scratch.push(root);
	const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
	return { root, state, activity: new ActivityStore(state) };
}

const wardrobe = (ids: string[], locked?: string): Wardrobe => ({
	outfits: ids.map((id) => ({ id, name: id, description: id })),
	...(locked ? { locked } : {}),
});

// Generated part combinations: outfits that reference the part catalog by slot.
const comboWardrobe = (ids: string[], locked?: string): Wardrobe => ({
	parts: [
		{ id: "sock-white", slot: "feet", name: "白袜", description: "白袜" },
		{ id: "sock-black", slot: "feet", name: "黑袜", description: "黑袜" },
		{ id: "top-plain", slot: "torso", name: "白衬衫", description: "白衬衫" },
	],
	outfits: ids.map((id, index) => ({
		id,
		name: `组合${id}`,
		description: "synthesized",
		parts: { feet: index % 2 === 0 ? "sock-white" : "sock-black", torso: "top-plain" },
		generated: true,
	})),
	...(locked ? { locked } : {}),
});

describe("activity store", () => {
	test("a session sees persona plus its own project, never another project", () => {
		const { root, state, activity } = setup();
		const a = join(root, "alpha");
		const b = join(root, "beta");
		activity.prepare("s1", a, "question one", wardrobe([]), 1000);
		activity.prepare("s2", b, "question two", wardrobe([]), 2000);
		const third = activity.prepare("s1", a, "question three", wardrobe([]), 3000);
		// s1 already knows its own query; the other project's query is filtered
		// out by scope, so nothing repeats in any digest (Q01/Q03/S09).
		expect(third.context.sessions).toEqual([]);
		expect(third.projectId).toBe(resolveProjectIdentity(a).projectId);
		expect(state.getProject(third.projectId)).toBeTruthy();
		// The stored log does hold both queries for their own scopes.
		const bView = state.activitiesSince(0, resolveProjectIdentity(b).projectId, 10000);
		expect(bView.events.map((event) => event.payload)).toContain("question two");
	});

	test("consecutive queries with no shared changes carry only the new time", () => {
		const { root, activity, state } = setup();
		const dir = join(root, "repo");
		activity.prepare("s", dir, "first", wardrobe([]), 1000);
		const second = activity.prepare("s", dir, "second", wardrobe([]), 2000);
		expect(second.context.sessions).toEqual([]);
		// But a persona event in between does reach the next message.
		state.appendActivity({ session: "s2", scope: { scope: "persona" }, kind: "memory_updated", payload: "note" });
		const third = activity.prepare("s", dir, "third", wardrobe([]), 3000);
		expect(third.context.sessions.flatMap((summary) => summary.memoryUpdates)).toContain("note");
	});

	test("idle window reselects the outfit once, busy window keeps it", () => {
		const { root, activity, state } = setup();
		const dir = join(root, "repo");
		const first = activity.prepare("s1", dir, "q1", wardrobe(["a", "b"]), 1000);
		const chosen = first.context.outfit;
		expect(chosen).toBeTruthy();
		const soon = activity.prepare("s2", dir, "q2", wardrobe(["a", "b"]), 2000);
		expect(soon.context.outfit?.id).toBe(chosen!.id);
		const idle = activity.prepare("s3", dir, "q3", wardrobe(["a", "b"]), 2000 + OUTFIT_IDLE_MS + 1);
		expect(idle.context.outfit?.id).toBeTruthy();
		expect(idle.context.outfit?.id).not.toBe(chosen!.id);
		expect(state.getWardrobeState().current).toBe(idle.context.outfit!.id);
	});

	test("locked outfit wins and empty wardrobe yields no outfit block", () => {
		const { root, activity } = setup();
		const dir = join(root, "repo");
		const locked = activity.prepare("s", dir, "q", wardrobe(["a", "b"], "b"), 1000);
		expect(locked.context.outfit?.id).toBe("b");
		const later = activity.prepare("s", dir, "q2", wardrobe(["a", "b"], "b"), 1000 + OUTFIT_IDLE_MS);
		expect(later.context.outfit?.id).toBe("b");
		const empty = activity.prepare("s2", join(root, "other"), "q3", { outfits: [] }, 2000);
		expect(empty.context.outfit).toBeUndefined();
	});

	test("busy window keeps a generated combination, idle rotates, lock wins", () => {
		const { root, activity, state } = setup();
		const dir = join(root, "repo");
		const combos = comboWardrobe(["combo-aaaa", "combo-bbbb"]);
		const first = activity.prepare("s1", dir, "q1", combos, 1000);
		const current = first.context.outfit!;
		expect(current).toBeTruthy();
		// The combination arrives with its parts mapping intact.
		expect(current.parts).toEqual({ feet: expect.any(String), torso: "top-plain" });
		// Busy window: the exact combination id stays.
		const busy = activity.prepare("s2", dir, "q2", combos, 1500);
		expect(busy.context.outfit?.id).toBe(current.id);
		// Idle window (past the LAST user timestamp): another outfit —
		// combinations participate, individual parts do not.
		const idleAt = 1500 + OUTFIT_IDLE_MS + 1;
		const idle = activity.prepare("s3", dir, "q3", combos, idleAt);
		expect(idle.context.outfit?.id).not.toBe(current.id);
		// Lock wins over idle selection.
		const locked = activity.prepare(
			"s4",
			dir,
			"q4",
			comboWardrobe(["combo-aaaa", "combo-bbbb"], "combo-aaaa"),
			idleAt + OUTFIT_IDLE_MS + 1,
		);
		expect(locked.context.outfit?.id).toBe("combo-aaaa");
		expect(state.getWardrobeState().current).toBe("combo-aaaa");
	});

	test("outfit_changed rows record <id>: <name>", () => {
		const { root, activity, state } = setup();
		const dir = join(root, "repo");
		const combos = comboWardrobe(["combo-aaaa", "combo-bbbb"]);
		const first = activity.prepare("s1", dir, "q1", combos, 1000);
		const chosen = first.context.outfit!;
		const idle = activity.prepare("s2", dir, "q2", combos, 1000 + OUTFIT_IDLE_MS + 1);
		const next = idle.context.outfit!;
		expect(next.id).not.toBe(chosen.id);
		const rows = state.activitiesSince(0, null, 10000).events.filter((event) => event.kind === "outfit_changed");
		expect(rows.map((row) => row.payload)).toContain(`${next.id}: ${next.name}`);
	});

	test("activity retention prunes after 21 days and flags history expiry", () => {
		const { root, activity, state } = setup();
		const dir = join(root, "repo");
		const day = 86_400_000;
		const longAgo = Date.now() - 30 * day;
		// s1 delivered long ago; a persona event it never saw also happened long ago.
		activity.prepare("s1", dir, "old query", wardrobe([]), longAgo);
		state.appendActivity({
			session: "s2",
			scope: { scope: "persona" },
			kind: "memory_updated",
			payload: "unseen note",
			now: longAgo + 1000,
		});
		const fresh = activity.prepare("s1", dir, "back again", wardrobe([]), Date.now());
		// The ancient event is delivered once as a digest with the expiry flag
		// (Q10); the prune at the end of that prepare removes it from later
		// deliveries.
		expect(fresh.context.historyExpired).toBe(true);
		expect(fresh.context.sessions.flatMap((summary) => summary.memoryUpdates)).toEqual(["unseen note"]);
		const after = activity.prepare("s1", dir, "still here", wardrobe([]), Date.now() + 1);
		expect(after.context.sessions).toEqual([]);
		expect(after.context.historyExpired).toBe(false);
		expect(state.lastActivitySeq()).toBeGreaterThan(0);
	});

	test("stored previews are byte-bounded per kind and mark cuts with an ellipsis", () => {
		const { root, state, activity } = setup();
		const dir = join(root, "repo");
		const projectId = resolveProjectIdentity(dir).projectId;
		const longMultibyte = "あ".repeat(100);
		const longEmoji = "😀".repeat(100);
		activity.append("user_query", "s", projectId, longMultibyte);
		activity.append("user_query", "s", projectId, longEmoji);
		activity.append("continuity_updated", "s", projectId, longMultibyte);
		activity.append("memory_updated", "s", projectId, longMultibyte);
		// A payload that already fits the limit is stored verbatim, unmarked.
		activity.append("user_query", "s", projectId, "a".repeat(240));
		const rows = state.activitiesSince(0, projectId, 1_000_000).events;
		const [query, emoji, continuity, memoryUpdate, exactFit] = rows;
		// 240-byte kind budgets: the cut keeps whole code points and the
		// ellipsis stays inside the budget (79*3 + 3 bytes, 59*4 + 3 bytes).
		expect(Buffer.byteLength(query.payload, "utf8")).toBe(240);
		expect(query.payload.endsWith("…")).toBe(true);
		expect(query.payload.startsWith("あ".repeat(79))).toBe(true);
		expect(Buffer.byteLength(emoji.payload, "utf8")).toBeLessThanOrEqual(240);
		expect(emoji.payload.endsWith("…")).toBe(true);
		expect(emoji.payload.startsWith("😀".repeat(59))).toBe(true);
		// continuity_updated gets the tighter 180-byte budget.
		expect(Buffer.byteLength(continuity.payload, "utf8")).toBe(180);
		expect(continuity.payload).toBe(`${"あ".repeat(59)}…`);
		// Other kinds share the 240-byte budget.
		expect(Buffer.byteLength(memoryUpdate.payload, "utf8")).toBe(240);
		expect(memoryUpdate.payload.endsWith("…")).toBe(true);
		expect(exactFit.payload).toBe("a".repeat(240));
	});

	test("outfit_changed rows preview long names too", () => {
		const { root, activity, state } = setup();
		const dir = join(root, "repo");
		const longName = "名".repeat(300);
		const outfits: Wardrobe = {
			outfits: [{ id: "shirt-long", name: longName, description: "d" }],
		};
		activity.prepare("s1", dir, "q1", outfits, 1000);
		const rows = state.activitiesSince(0, null, 10000).events.filter((event) => event.kind === "outfit_changed");
		expect(rows).toHaveLength(1);
		expect(Buffer.byteLength(rows[0]!.payload, "utf8")).toBeLessThanOrEqual(240);
		expect(rows[0]!.payload.startsWith("shirt-long: 名")).toBe(true);
		expect(rows[0]!.payload.endsWith("…")).toBe(true);
	});

	test("fresh contexts carry session summaries and omit raw events", () => {
		const { root, activity, state } = setup();
		const dir = join(root, "repo");
		state.appendActivity({
			session: "s-other",
			scope: { scope: "persona" },
			kind: "user_query",
			payload: "their question",
			now: 1500,
		});
		const { context } = activity.prepare("s-viewer", dir, "my question", wardrobe([]), 2000);
		expect(context.sessions.map((summary) => summary.session)).toEqual(["s-other"]);
		expect(context.sessions[0]!.recentQueries).toEqual(["their question"]);
		// The delivery shape is the digest: raw events never ride along.
		expect("events" in context).toBe(false);
		expect(context.events).toBeUndefined();
	});

	test("several long sessions collapse into compact per-session summaries", () => {
		const event = (
			seq: number,
			time: number,
			session: string | null,
			kind: string,
			payload: string,
		): ActivityEvent => ({
			seq,
			time,
			session,
			scope: "persona",
			projectId: null,
			kind,
			payload,
		});
		const long = (label: string, index: number) => `${label} number ${index} with plenty of surrounding detail text`;
		// Three sessions with bulky histories, plus one unattributed event.
		const events: ActivityEvent[] = [
			...Array.from({ length: 12 }, (_, index) =>
				event(index + 1, 1000 + index, "s-alpha", "user_query", long("alpha query", index)),
			),
			...Array.from({ length: 7 }, (_, index) =>
				event(13 + index, 2000 + index, "s-alpha", "memory_updated", `anchor: fact ${index} (updated)`),
			),
			event(20, 3000, "s-alpha", "continuity_updated", "alpha continuity body one"),
			event(21, 3100, "s-alpha", "continuity_updated", "alpha continuity body two"),
			event(22, 3200, "s-alpha", "outfit_changed", "shirt-a: 衬衫甲"),
			...Array.from({ length: 3 }, (_, index) =>
				event(23 + index, 4000 + index, "s-beta", "user_query", long("beta query", index)),
			),
			event(26, 5000, "s-beta", "memory_updated", "anchor: shared fact (created)"),
			event(27, 6000, "s-gamma", "user_query", "gamma only question"),
			event(28, 900, null, "memory_updated", "unattributed background write"),
		];
		const summaries = summarizeActivityEvents(events);
		// Ordered by most recent activity: gamma, beta, alpha, then the
		// unattributed group keyed by its placeholder.
		expect(summaries.map((summary) => summary.session)).toEqual(["s-gamma", "s-beta", "s-alpha", "(no session)"]);
		const alpha = summaries[2]!;
		expect(alpha.queries).toBe(12);
		// Only the two newest query previews survive.
		expect(alpha.recentQueries).toEqual([long("alpha query", 10), long("alpha query", 11)]);
		// Only five unique memory-update labels survive.
		expect(alpha.memoryUpdates).toEqual([
			"anchor: fact 0 (updated)",
			"anchor: fact 1 (updated)",
			"anchor: fact 2 (updated)",
			"anchor: fact 3 (updated)",
			"anchor: fact 4 (updated)",
		]);
		// Continuity and outfit bodies are counted, never repeated.
		expect(alpha.continuityUpdates).toBe(2);
		expect(alpha.outfitChanges).toBe(1);
		expect(summaries.join("\n")).not.toContain("alpha continuity body");
		expect(summaries.join("\n")).not.toContain("衬衫甲");
		expect(alpha.firstSeen).toBe(1000);
		expect(alpha.lastSeen).toBe(3200);
		const beta = summaries[1]!;
		expect(beta.queries).toBe(3);
		expect(beta.recentQueries).toEqual([long("beta query", 1), long("beta query", 2)]);
		expect(beta.memoryUpdates).toEqual(["anchor: shared fact (created)"]);
		expect(summaries[0]!.recentQueries).toEqual(["gamma only question"]);
		// The collapse is real: the digest is far smaller than the raw window.
		expect(Buffer.byteLength(JSON.stringify(summaries))).toBeLessThan(Buffer.byteLength(JSON.stringify(events)) / 3);
	});

	test("a recent continuity and memory flood cannot evict per-session query previews", () => {
		const { root, state, activity } = setup();
		const dir = join(root, "repo");
		state.appendActivity({
			session: "s-a",
			scope: { scope: "persona" },
			kind: "user_query",
			payload: "alpha question",
			now: 100,
		});
		state.appendActivity({
			session: "s-b",
			scope: { scope: "persona" },
			kind: "user_query",
			payload: "beta question",
			now: 101,
		});
		state.appendActivity({
			session: "s-c",
			scope: { scope: "persona" },
			kind: "user_query",
			payload: "charlie first",
			now: 102,
		});
		state.appendActivity({
			session: "s-c",
			scope: { scope: "persona" },
			kind: "user_query",
			payload: "charlie second",
			now: 103,
		});
		state.appendActivity({
			session: "s-c",
			scope: { scope: "persona" },
			kind: "user_query",
			payload: "charlie third",
			now: 104,
		});
		// A continuity flood that alone would fill the whole budget: under a
		// plain newest-fill it evicts every query and the digest goes blind
		// (the observed real-data failure: all sessions at queries: 0).
		const flood = "x".repeat(500);
		for (let index = 0; index < 16; index++)
			state.appendActivity({
				session: "s-flood",
				scope: { scope: "persona" },
				kind: "continuity_updated",
				payload: flood,
				now: 200 + index,
			});
		for (const [index, note] of ["note zero", "note one", "note two"].entries())
			state.appendActivity({
				session: "s-note",
				scope: { scope: "persona" },
				kind: "memory_updated",
				payload: note,
				now: 300 + index,
			});
		const viewer = activity.prepare("s-viewer", dir, "viewer question", wardrobe([]), 1000);
		const digest = viewer.context.sessions;
		// Ordered by recency: the newest writers first, every session still
		// represented with its newest query previews (up to two).
		expect(digest.map((summary) => summary.session)).toEqual(["s-note", "s-flood", "s-c", "s-b", "s-a"]);
		expect(digest[4]!.recentQueries).toEqual(["alpha question"]);
		expect(digest[3]!.recentQueries).toEqual(["beta question"]);
		expect(digest[2]!.queries).toBe(2);
		expect(digest[2]!.recentQueries).toEqual(["charlie second", "charlie third"]);
		// Flooded kinds are counted, never repeated, and the digest stays a
		// fraction of the 8 KB raw window.
		expect(digest[1]!.continuityUpdates).toBe(15);
		expect(digest[1]!.queries).toBe(0);
		expect(digest[0]!.memoryUpdates).toEqual(["note zero", "note one", "note two"]);
		expect(JSON.stringify(digest)).not.toContain(flood);
		expect(Buffer.byteLength(JSON.stringify(digest))).toBeLessThan(1500);
		// Omitted accounting stays honest: charlie's oldest query and the
		// oldest flood row fell out of the budget.
		expect(viewer.context.omitted).toBe(2);
		// The raw selection itself: bounded, sequence-ascending, and still
		// carrying the reserved queries.
		const window = state.activitiesSince(
			0,
			resolveProjectIdentity(dir).projectId,
			ACTIVITY_BUDGET_BYTES,
			undefined,
			2,
		);
		const used = window.events.reduce((total, row) => total + Buffer.byteLength(row.payload), 0);
		expect(used).toBeLessThanOrEqual(ACTIVITY_BUDGET_BYTES);
		expect(window.events.map((row) => row.payload)).toContain("alpha question");
		const seqs = window.events.map((row) => row.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(window.omitted).toBe(2);
	});

	test("query reservations that alone exceed the budget keep only the newest queries", () => {
		const { state } = setup();
		for (let index = 0; index < 8; index++)
			state.appendActivity({
				session: `s-${index}`,
				scope: { scope: "persona" },
				kind: "user_query",
				payload: "q".repeat(1100),
				now: 1000 + index,
			});
		const window = state.activitiesSince(0, null, ACTIVITY_BUDGET_BYTES, undefined, 2);
		// Seven newest reservations fit (7700 bytes); the oldest query drops
		// and the leftover budget buys nothing else.
		expect(window.events).toHaveLength(7);
		expect(window.events.map((row) => row.session)).toEqual(["s-1", "s-2", "s-3", "s-4", "s-5", "s-6", "s-7"]);
		expect(window.omitted).toBe(1);
	});
});
