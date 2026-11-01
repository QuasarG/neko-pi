import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CustomMessage } from "../src/core/messages.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { type GoalRow, RuntimeState } from "../src/core/runtime/state-db.ts";
import { continuationDecision, formatGoalContinuation, formatGoalStatusText } from "../src/extensions/goal/index.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const goal = (overrides: Partial<GoalRow> = {}): GoalRow => ({
	session: "s1",
	goal: "make the build green",
	status: "active",
	rounds: 3,
	maxRounds: 20,
	created: 1,
	updated: 2,
	...overrides,
});

describe("continuationDecision", () => {
	test("continues with the next round on a clean end", () => {
		expect(continuationDecision(goal(), { pendingUser: false, runningJobs: 0, lastStopReason: "stop" })).toEqual({
			action: "continue",
			round: 4,
		});
	});

	test("defers to queued user input and running background jobs", () => {
		expect(continuationDecision(goal(), { pendingUser: true, runningJobs: 0, lastStopReason: "stop" })).toEqual({
			action: "defer",
			reason: "pendingUser",
		});
		expect(continuationDecision(goal(), { pendingUser: false, runningJobs: 2, lastStopReason: "stop" })).toEqual({
			action: "defer",
			reason: "backgroundJobs",
		});
	});

	test("an aborted turn pauses the loop", () => {
		expect(continuationDecision(goal(), { pendingUser: false, runningJobs: 0, lastStopReason: "aborted" })).toEqual({
			action: "pause",
			reason: "aborted",
		});
	});

	test("the round cap and inactive goals stop it", () => {
		expect(
			continuationDecision(goal({ rounds: 20 }), { pendingUser: false, runningJobs: 0, lastStopReason: "stop" }),
		).toEqual({
			action: "stop",
			reason: "maxRounds",
		});
		expect(
			continuationDecision(goal({ status: "completed" }), {
				pendingUser: false,
				runningJobs: 0,
				lastStopReason: "stop",
			}),
		).toEqual({ action: "stop", reason: "inactive" });
		// R48 (user order): a goal the model marks blocked stops the loop the
		// same way — no more rounds burned on an unprogressable objective.
		expect(
			continuationDecision(goal({ status: "blocked" }), {
				pendingUser: false,
				runningJobs: 0,
				lastStopReason: "stop",
			}),
		).toEqual({ action: "stop", reason: "inactive" });
		expect(continuationDecision(undefined, { pendingUser: false, runningJobs: 0, lastStopReason: "stop" })).toEqual({
			action: "stop",
			reason: "inactive",
		});
	});
});

describe("formatGoalStatusText", () => {
	test("projects objective, loop status and rounds/cap as one line", () => {
		// Canonical fixture: the web parser test pins the same string.
		expect(formatGoalStatusText(goal())).toBe("goal 3/20 active make the build green");
	});

	test("flattens a multi-line objective and carries the paused state", () => {
		// Canonical fixture: the web parser test pins the same string.
		expect(
			formatGoalStatusText(goal({ goal: "ship\n  the  release", status: "paused", rounds: 0, maxRounds: 5 })),
		).toBe("goal 0/5 paused ship the release");
	});
});

describe("formatGoalContinuation", () => {
	test("carries only goal state — no other injected information", () => {
		const text = formatGoalContinuation(goal(), 4);
		expect(text).toContain("<goal_continuation>");
		expect(text).toContain("round 4/20");
		expect(text).toContain("make the build green");
		expect(text).toContain('goal_update with status="completed"');
		expect(text).toContain('status="blocked"');
		// The body must not smuggle in memory, activity, or persona data.
		expect(text).not.toContain("runtime_activity");
		expect(text).not.toContain("runtime_memory");
	});
});

describe("goal storage", () => {
	test("set, update, and clear round-trip through the goals table", () => {
		const root = mkdtempSync(join(tmpdir(), "neko-goal-"));
		dirs.push(root);
		const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
		expect(state.getGoal("s1")).toBeUndefined();
		state.setGoal("s1", "ship the release", 5);
		expect(state.getGoal("s1")).toMatchObject({
			goal: "ship the release",
			status: "active",
			rounds: 0,
			maxRounds: 5,
		});
		state.updateGoal("s1", { roundsDelta: 1 });
		expect(state.getGoal("s1")?.rounds).toBe(1);
		state.updateGoal("s1", { status: "completed" });
		expect(state.getGoal("s1")?.status).toBe("completed");
		// Re-setting resets the loop counters.
		state.setGoal("s1", "ship it again", 9);
		expect(state.getGoal("s1")).toMatchObject({ goal: "ship it again", status: "active", rounds: 0, maxRounds: 9 });
		state.clearGoal("s1");
		expect(state.getGoal("s1")).toBeUndefined();
		state.close();
	});
});

describe("automated traffic rides the user-turn channel without impersonating", () => {
	test("custom messages convert to an end-appended user turn (cache-safe)", () => {
		const message: CustomMessage = {
			role: "custom",
			customType: "goal-continuation",
			content: "[AUTOMATED CONTINUATION - NOT USER INPUT]\n<goal_continuation>keep going</goal_continuation>",
			display: false,
			timestamp: 1,
		};
		const [converted] = convertToLlm([message]);
		// Same channel as user queries: appended at the end, prefix-cache-safe
		// on every protocol. Identity lives in the content marker and the
		// custom_message storage, not in the wire role.
		expect(converted?.role).toBe("user");
		expect(converted?.content).toEqual([
			{
				type: "text",
				text: "[AUTOMATED CONTINUATION - NOT USER INPUT]\n<goal_continuation>keep going</goal_continuation>",
			},
		]);
	});

	test("continuation bodies carry the anti-spoof preamble", () => {
		expect(formatGoalContinuation(goal(), 4)).toContain("[AUTOMATED CONTINUATION - NOT USER INPUT]");
	});
});
