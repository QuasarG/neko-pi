import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	clearFinishedBackgroundJobs,
	finishBackgroundJob,
	listBackgroundJobs,
	registerBackgroundJob,
} from "../../src/core/tools/background-jobs.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import backgroundJobsExtension from "../../src/extensions/background-jobs/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

let root: string;
const harnesses: Harness[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "background-isolation-"));
	vi.stubEnv("NEKO_PI_HOME", root);
});

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const job of listBackgroundJobs()) {
		if (job.status === "running") finishBackgroundJob(job.id, { status: "completed", summary: "cleanup" });
	}
	clearFinishedBackgroundJobs();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

async function startSession() {
	const harness = await createHarness({
		extensionFactories: [{ name: "background-jobs", factory: backgroundJobsExtension }],
	});
	harnesses.push(harness);
	const setStatus = vi.fn();
	await harness.session.bindExtensions({ uiContext: createTestUiContext({ setStatus }), mode: "tui" });
	return { harness, setStatus, id: harness.session.sessionId };
}

const notifications = (harness: Harness) =>
	harness.session.messages.filter((message) => message.role === "custom" && message.customType === "background-task");

test("concurrent sessions receive only their own background result and running status", async () => {
	const a = await startSession();
	const b = await startSession();
	a.harness.setResponses([fauxAssistantMessage("received A")]);
	b.harness.setResponses([fauxAssistantMessage("received B")]);
	const jobA = registerBackgroundJob({ sessionId: a.id, kind: "bash", label: "private A" });
	const jobB = registerBackgroundJob({ sessionId: b.id, kind: "subagent", label: "private B" });
	expect(a.setStatus).toHaveBeenLastCalledWith("background", "1 background job");
	expect(b.setStatus).toHaveBeenLastCalledWith("background", "1 background job");
	finishBackgroundJob(jobA.id, { status: "completed", summary: "A's result" });
	await vi.waitFor(() => expect(notifications(a.harness)).toHaveLength(1));
	await a.harness.session.agent.waitForIdle();
	expect(notifications(b.harness)).toHaveLength(0);
	expect(a.setStatus).toHaveBeenLastCalledWith("background", undefined);
	expect(b.setStatus).toHaveBeenLastCalledWith("background", "1 background job");
	finishBackgroundJob(jobB.id, { status: "completed", summary: "B's result" });
	await vi.waitFor(() => expect(notifications(b.harness)).toHaveLength(1));
	await b.harness.session.agent.waitForIdle();
	expect(notifications(a.harness)).toHaveLength(1);
});

test("/tasks exposes only the current session's jobs", async () => {
	const a = await startSession();
	const b = await startSession();
	registerBackgroundJob({ sessionId: a.id, kind: "bash", label: "task-A", notify: false });
	const own = registerBackgroundJob({ sessionId: b.id, kind: "bash", label: "task-B", notify: false });
	await b.harness.session.prompt("/tasks");
	const report = b.harness.session.messages.findLast(
		(message) => message.role === "custom" && message.customType === "tasks-report",
	);
	if (report?.role !== "custom") throw new Error("Missing tasks report");
	expect(report?.content).toContain(own.id);
	expect(report?.details).toEqual({ count: 1 });
	expect(listBackgroundJobs(a.id)).toHaveLength(1);
	expect(listBackgroundJobs(b.id)).toHaveLength(1);
});

test("a result completed during reload is delivered once when its owner returns", async () => {
	const a = await startSession();
	const job = registerBackgroundJob({ sessionId: a.id, kind: "bash", label: "reload gap" });
	await a.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
	finishBackgroundJob(job.id, { status: "completed", summary: "finished during reload" });
	expect(notifications(a.harness)).toHaveLength(0);
	a.harness.setResponses([fauxAssistantMessage("received after reload")]);
	await a.harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
	await vi.waitFor(() => expect(notifications(a.harness)).toHaveLength(1));
	await a.harness.session.agent.waitForIdle();
	await a.harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
	expect(notifications(a.harness)).toHaveLength(1);
	expect(job.notify).toBe(false);
});

test("bash retains task ownership when shell session metadata is disabled", async () => {
	const harness = await createHarness({
		extensionFactories: [
			{ name: "background-jobs", factory: backgroundJobsExtension },
			{
				name: "private-bash",
				factory: (pi) => pi.registerTool(createBashToolDefinition(root, { exposeSessionEnvironment: false })),
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.3; printf owned-output", background: true }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("parent finished"),
		fauxAssistantMessage("result received"),
	]);
	await harness.session.prompt("start a local background command");
	const [job] = listBackgroundJobs(harness.session.sessionId);
	expect(job?.kind).toBe("bash");
	await vi.waitFor(() => expect(job?.status).toBe("completed"));
	await harness.session.agent.waitForIdle();
	expect(job?.summary).toContain("owned-output");
	expect(notifications(harness)).toHaveLength(1);
});
