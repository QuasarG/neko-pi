import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { getRuntimeState } from "../../src/core/runtime/state-db.ts";
import {
	clearFinishedBackgroundJobs,
	finishBackgroundJob,
	registerBackgroundJob,
} from "../../src/core/tools/background-jobs.ts";
import goalExtension from "../../src/extensions/goal/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const factories = [{ name: "goal", factory: goalExtension }];
let root: string;
const harnesses: Harness[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "goal-suite-"));
	vi.stubEnv("NEKO_PI_HOME", root);
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

test("a set goal continues itself on the user-turn channel until goal_update completes it", async () => {
	const harness = await createHarness({ extensionFactories: factories });
	harnesses.push(harness);
	const session = harness.sessionManager.getSessionId();
	getRuntimeState().setGoal(session, "count to two", 5);
	const unrelated = registerBackgroundJob({ sessionId: "another-session", kind: "bash", label: "unrelated work" });

	harness.setResponses([
		fauxAssistantMessage("round one done"),
		// Round two is the self-continuation: it sees the frame-marked goal
		// block, reports completion, and the loop stops.
		fauxAssistantMessage(fauxToolCall("goal_update", { status: "completed", reason: "done" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("goal finished"),
	]);
	await harness.session.prompt("start");

	// The continuation entry exists, is a custom_message (never a user
	// entry), and rides the same end-appended user-turn channel as real
	// queries — prefix-cache-safe on every protocol, frame-marked instead.
	const messages = harness.session.messages as AgentMessage[];
	const continuations = messages.filter(
		(message) => message.role === "custom" && (message as { customType?: string }).customType === "goal-continuation",
	);
	expect(continuations.length).toBeGreaterThanOrEqual(1);
	const userTurns = messages.filter((message) => message.role === "user");
	expect(userTurns).toHaveLength(1);
	const wire = convertToLlm(messages);
	const continuationWire = wire.find(
		(message) =>
			typeof message.content === "object" &&
			message.content.some((block) => block.type === "text" && block.text.includes("<goal_continuation>")),
	);
	expect(continuationWire?.role).toBe("user");
	const continuationText = (continuationWire?.content as Array<{ type: string; text?: string }> | undefined)
		?.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	expect(continuationText).toContain("[AUTOMATED CONTINUATION - NOT USER INPUT]");

	// The round counter advanced exactly once and the goal closed.
	const goal = getRuntimeState().getGoal(session);
	expect(goal?.rounds).toBe(1);
	expect(goal?.status).toBe("completed");
	finishBackgroundJob(unrelated.id, { status: "completed", summary: "done" });
	clearFinishedBackgroundJobs();
});
