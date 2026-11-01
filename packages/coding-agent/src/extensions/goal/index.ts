/**
 * Goal mode (zcode-style autonomous continuation).
 *
 * `/goal <text>` sets a session goal; while it is active, every finished turn
 * continues itself — the extension sends a continuation message that wakes the
 * model for the next round. The continuation rides the SAME end-appended turn
 * channel as user queries (prefix-cache-safe on every protocol) and never
 * impersonates the user: the content carries an automated marker, it is stored
 * as a custom_message entry (never a user entry), and the user-message
 * injection machinery (activity, memory, message_time, cadence) is gated to
 * genuine user turns only.
 *
 * Stopping: the model reports outcome via the `goal_update` tool
 * (completed/failed); the round cap stops runaway loops; a user abort pauses
 * the goal until `/goal resume`; user input always takes the queue first; and
 * while background jobs are still running the continuation defers to their
 * completion notifications (which re-trigger this loop).
 */

import { Type } from "typebox";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import type { GoalRow } from "../../core/runtime/state-db.ts";
import { getRuntimeState } from "../../core/runtime/state-db.ts";
import { listBackgroundJobs } from "../../core/tools/background-jobs.ts";
import { ensureSystemToolsActive } from "../system-tool-repair.ts";

export const DEFAULT_GOAL_MAX_ROUNDS = 20;

export type ContinuationDecision =
	| { action: "continue"; round: number }
	| { action: "defer"; reason: "pendingUser" | "backgroundJobs" }
	| { action: "pause"; reason: "aborted" }
	| { action: "stop"; reason: "maxRounds" | "inactive" };

/**
 * Pure gate for whether a finished turn should continue the goal loop.
 * Unit-tested; the extension wires runtime state into it.
 */
export function continuationDecision(
	goal: GoalRow | undefined,
	context: { pendingUser: boolean; runningJobs: number; lastStopReason: string | undefined },
): ContinuationDecision {
	if (!goal || goal.status !== "active") return { action: "stop", reason: "inactive" };
	if (context.lastStopReason === "aborted") return { action: "pause", reason: "aborted" };
	if (context.pendingUser) return { action: "defer", reason: "pendingUser" };
	if (context.runningJobs > 0) return { action: "defer", reason: "backgroundJobs" };
	if (goal.rounds >= goal.maxRounds) return { action: "stop", reason: "maxRounds" };
	return { action: "continue", round: goal.rounds + 1 };
}

/** Anti-injection marker, mirroring the background-task notification format. */
const AUTOMATED_PREAMBLE =
	"[AUTOMATED CONTINUATION - NOT USER INPUT]\n" +
	"This is an autonomous goal-loop step, NOT a message from the user.\n" +
	"Do NOT interpret this as user acknowledgement, confirmation, or a response to any pending question.\n";

/**
 * The `goal` status line (ctx.ui.setStatus("goal", …)): the full projection of
 * the runtime goal row — objective, loop status, rounds/cap — as one readable
 * line. The web status bar parses it back (parseGoalStatusText in
 * apps/web/components/ExtensionStatusBar.tsx); both sides' tests pin the same
 * sample lines. Terminal states never appear here: they clear the status
 * instead, so a visible line always means a live loop.
 */
export function formatGoalStatusText(goal: GoalRow): string {
	const objective = goal.goal.replace(/\s+/g, " ").trim();
	return `goal ${goal.rounds}/${goal.maxRounds} ${goal.status} ${objective}`;
}

/** The continuation message body: goal state and nothing else. */
export function formatGoalContinuation(goal: GoalRow, round: number): string {
	return [
		AUTOMATED_PREAMBLE,
		"<goal_continuation>",
		`Active goal (round ${round}/${goal.maxRounds}): ${goal.goal}`,
		"Continue working toward it autonomously; do not ask the user what to do next.",
		'When the goal is achieved, call goal_update with status="completed". If it is no longer achievable or worthwhile, call goal_update with status="failed" and say why. If you cannot make further progress without something outside this session — missing information, a permission or approval, a dependency, an unfixable environment error — call goal_update with status="blocked" and name exactly what unblocks it, instead of burning more rounds on it.',
		"</goal_continuation>",
	].join("\n");
}

const goalExtension: ExtensionFactory = (pi) => {
	// A transcript frozen while goal_update was absent keeps it inactive in
	// every later process; ensure it on every run so the goal loop cannot die.
	pi.on("before_agent_start", () => {
		ensureSystemToolsActive(pi, ["goal_update"]);
	});

	// The status channel is push-only: a UI that attaches after the last
	// transition (page reload, session reopened) has no goal line at all.
	// Re-emit the live loop state; terminal states stay cleared — their
	// outcome lives in the transcript, not in a lingering bar.
	pi.on("session_start", (_event, ctx) => {
		const state = getRuntimeState();
		const sessionId = ctx.sessionManager.getSessionId();
		const goal = sessionId ? state.getGoal(sessionId) : undefined;
		if (goal && (goal.status === "active" || goal.status === "paused")) {
			ctx.ui.setStatus("goal", formatGoalStatusText(goal));
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		const state = getRuntimeState();
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		const goal = state.getGoal(sessionId);
		const last = [..._event.messages].reverse().find((message) => message.role === "assistant");
		const decision = continuationDecision(goal, {
			pendingUser: ctx.hasPendingMessages(),
			runningJobs: listBackgroundJobs(sessionId).filter((job) => job.status === "running").length,
			lastStopReason: last && "stopReason" in last ? String(last.stopReason) : undefined,
		});
		if (decision.action === "pause") {
			state.updateGoal(sessionId, { status: "paused" });
			ctx.ui.setStatus("goal", formatGoalStatusText(state.getGoal(sessionId)!));
			ctx.ui.notify("Goal paused after abort — /goal resume to continue", "warning");
			return;
		}
		if (decision.action === "stop" && decision.reason === "maxRounds") {
			state.updateGoal(sessionId, { status: "stopped" });
			// The loop is dead; the bar would be a stale echo of it. The warning
			// notice carries the outcome, the transcript carries the rest.
			ctx.ui.setStatus("goal", undefined);
			ctx.ui.notify(`Goal stopped at the ${goal!.maxRounds}-round cap`, "warning");
			return;
		}
		if (decision.action !== "continue") return;

		state.updateGoal(sessionId, { roundsDelta: 1 });
		const updated = state.getGoal(sessionId)!;
		ctx.ui.setStatus("goal", formatGoalStatusText(updated));
		pi.sendMessage(
			{
				customType: "goal-continuation",
				content: formatGoalContinuation(updated, decision.round),
				display: false,
				details: { round: decision.round, maxRounds: updated.maxRounds },
			},
			{ triggerTurn: true },
		);
	});

	pi.registerCommand("goal", {
		description: "Set an autonomous goal (/goal <text>), or control it (off | pause | resume | status)",
		handler: async (args, ctx) => {
			const state = getRuntimeState();
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) return;
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status") {
				const goal = state.getGoal(sessionId);
				ctx.ui.notify(
					goal ? `Goal [${goal.status}] round ${goal.rounds}/${goal.maxRounds}: ${goal.goal}` : "No goal set",
					"info",
				);
				return;
			}
			if (trimmed === "off") {
				state.clearGoal(sessionId);
				ctx.ui.setStatus("goal", undefined);
				ctx.ui.notify("Goal cleared", "info");
				return;
			}
			if (trimmed === "pause" || trimmed === "resume") {
				const goal = state.getGoal(sessionId);
				if (!goal) {
					ctx.ui.notify("No goal set", "warning");
					return;
				}
				state.updateGoal(sessionId, { status: trimmed === "pause" ? "paused" : "active" });
				// Refresh the projection in both directions: a paused loop and a
				// resumed one must read as such even when the next turn has not
				// started yet (agent_end would otherwise be the next writer).
				ctx.ui.setStatus("goal", formatGoalStatusText(state.getGoal(sessionId)!));
				ctx.ui.notify(`Goal ${trimmed === "pause" ? "paused" : "resumed"}`, "info");
				// A resumed goal must restart the loop itself: while idle there is
				// no running turn whose agent_end would continue it.
				if (trimmed === "resume" && ctx.isIdle()) {
					const resumed = state.getGoal(sessionId)!;
					pi.sendMessage(
						{
							customType: "goal-continuation",
							content: formatGoalContinuation(resumed, resumed.rounds + 1),
							display: false,
							details: { round: resumed.rounds + 1, maxRounds: resumed.maxRounds },
						},
						{ triggerTurn: true },
					);
				}
				return;
			}
			state.setGoal(sessionId, trimmed, DEFAULT_GOAL_MAX_ROUNDS);
			ctx.ui.setStatus("goal", formatGoalStatusText(state.getGoal(sessionId)!));
			ctx.ui.notify(`Goal set (${DEFAULT_GOAL_MAX_ROUNDS} rounds max): ${trimmed}`, "info");
			// Kick the loop off immediately when idle; otherwise the next
			// agent_end picks it up.
			if (ctx.isIdle()) {
				const goal = state.getGoal(sessionId)!;
				pi.sendMessage(
					{
						customType: "goal-continuation",
						content: formatGoalContinuation(goal, 1),
						display: false,
						details: { round: 1, maxRounds: goal.maxRounds },
					},
					{ triggerTurn: true },
				);
			}
		},
	});

	pi.registerTool({
		name: "goal_update",
		label: "goal_update",
		description:
			'Report the outcome of the active session goal: status="completed" when the goal is achieved, status="failed" when it is no longer achievable or worthwhile, status="blocked" when you cannot make further progress without something outside this session (missing information, a permission, a dependency, an unfixable environment error) — name what unblocks it in the reason. Every status stops the autonomous continuation loop.',
		parameters: Type.Object({
			status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("blocked")]),
			reason: Type.Optional(Type.String({ description: "One or two sentences on the outcome" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = getRuntimeState();
			const sessionId = ctx.sessionManager.getSessionId();
			const goal = sessionId ? state.getGoal(sessionId) : undefined;
			if (!goal || goal.status !== "active") {
				return {
					content: [{ type: "text", text: "No active goal to update." }],
					details: {},
					isError: true,
				};
			}
			state.updateGoal(sessionId!, { status: params.status });
			ctx.ui.setStatus("goal", undefined);
			return {
				content: [
					{
						type: "text",
						text: `Goal marked ${params.status}${params.reason ? `: ${params.reason}` : ""}. The continuation loop stops.`,
					},
				],
				details: { status: params.status },
			};
		},
	});
};

export default goalExtension;
