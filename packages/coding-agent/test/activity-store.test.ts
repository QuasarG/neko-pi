import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ActivityStore, OUTFIT_IDLE_MS } from "../src/core/activity.ts";
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

describe("activity store", () => {
	test("a session sees persona plus its own project, never another project", () => {
		const { root, state, activity } = setup();
		const a = join(root, "alpha");
		const b = join(root, "beta");
		activity.prepare("s1", a, "question one", wardrobe([]), 1000);
		activity.prepare("s2", b, "question two", wardrobe([]), 2000);
		const third = activity.prepare("s1", a, "question three", wardrobe([]), 3000);
		// s1 already knows its own query; the other project's query is filtered
		// out by scope, so no events repeat (Q01/Q03/S09).
		expect(third.context.events.map((event) => event.payload)).toEqual([]);
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
		expect(second.context.events).toEqual([]);
		// But a persona event in between does reach the next message.
		state.appendActivity({ session: "s2", scope: { scope: "persona" }, kind: "memory_updated", payload: "note" });
		const third = activity.prepare("s", dir, "third", wardrobe([]), 3000);
		expect(third.context.events.map((event) => event.payload)).toContain("note");
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
		// The ancient event is delivered once with the expiry flag (Q10); the
		// prune at the end of that prepare removes it from later deliveries.
		expect(fresh.context.historyExpired).toBe(true);
		expect(fresh.context.events.map((event) => event.payload)).toEqual(["unseen note"]);
		const after = activity.prepare("s1", dir, "still here", wardrobe([]), Date.now() + 1);
		expect(after.context.events).toEqual([]);
		expect(after.context.historyExpired).toBe(false);
		expect(state.lastActivitySeq()).toBeGreaterThan(0);
	});
});
