import { afterEach, describe, expect, test, vi } from "vitest";
import {
	type BackgroundJobEvent,
	clearFinishedBackgroundJobs,
	finishBackgroundJob,
	hasPendingBackgroundJobs,
	listBackgroundJobs,
	registerBackgroundJob,
	subscribeBackgroundJobs,
} from "../src/core/tools/background-jobs.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { formatJobNotification } from "../src/extensions/background-jobs/index.ts";

const subscriptions: Array<() => void> = [];
afterEach(() => {
	for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
	clearFinishedBackgroundJobs();
});

describe("background job registry", () => {
	test("register notifies started; finish notifies finished exactly once", () => {
		const events: BackgroundJobEvent[] = [];
		subscriptions.push(subscribeBackgroundJobs((event) => events.push(event)));
		const job = registerBackgroundJob({ kind: "bash", label: "echo hi" });
		expect(job.status).toBe("running");
		expect(events.map((event) => event.event)).toEqual(["started"]);

		finishBackgroundJob(job.id, { status: "completed", summary: "hi", exitCode: 0 });
		// A second finish is ignored — the notification delivers once.
		finishBackgroundJob(job.id, { status: "failed", summary: "dup", exitCode: 1 });
		expect(events.map((event) => event.event)).toEqual(["started", "finished"]);
		expect(events[1]!.job.status).toBe("completed");
		expect(listBackgroundJobs()).toHaveLength(1);
	});

	test("finishing an unknown id is a no-op", () => {
		expect(finishBackgroundJob("bg-999", { status: "completed", summary: "" })).toBeUndefined();
	});

	test("pending work follows its owner until its completion is delivered", () => {
		const job = registerBackgroundJob({ sessionId: "owner", kind: "bash", label: "pending" });
		expect(hasPendingBackgroundJobs("owner")).toBe(true);
		expect(hasPendingBackgroundJobs("other")).toBe(false);
		finishBackgroundJob(job.id, { status: "completed", summary: "done" });
		expect(hasPendingBackgroundJobs("owner")).toBe(true);
		job.notify = false;
		expect(hasPendingBackgroundJobs("owner")).toBe(false);
	});
});

describe("formatJobNotification", () => {
	test("zcode-style block: preamble, escaped fields, bounded summary", () => {
		const job = registerBackgroundJob({ kind: "bash", label: "grep <src> & more" });
		finishBackgroundJob(job.id, { status: "failed", summary: "boom & <bust>".repeat(400), exitCode: 3 });
		const text = formatJobNotification(listBackgroundJobs()[0]!);
		expect(text).toContain("[SYSTEM NOTIFICATION - NOT USER INPUT]");
		expect(text).toContain("<task-type>local_bash</task-type>");
		expect(text).toContain("<status>failed</status>");
		expect(text).toContain("&lt;src&gt;");
		expect(text).toContain("&amp;");
		expect(text).toContain("<exit-code>3</exit-code>");
		expect(text.length).toBeLessThan(3000);
	});
});

describe("bash background execution", () => {
	const ops = createLocalBashOperations();

	test("background:true resolves immediately and the job finishes with output", async () => {
		const finished = vi.fn();
		subscriptions.push(
			subscribeBackgroundJobs((event) => {
				if (event.event === "finished") finished(event.job);
			}),
		);
		const startedAt = Date.now();
		const result = await ops.exec("echo delayed-output && sleep 0.4", process.cwd(), {
			onData: () => {},
			background: true,
		});
		expect(result.backgrounded).toMatch(/^bg-/);
		expect(Date.now() - startedAt).toBeLessThan(300);
		expect(listBackgroundJobs()[0]!.status).toBe("running");

		await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(1), { timeout: 5000 });
		const job = finished.mock.calls[0]![0];
		expect(job.status).toBe("completed");
		expect(job.summary).toContain("delayed-output");
		expect(job.outputFile).toBeDefined();
	});

	test("timeout with background action hands the process off instead of killing it", async () => {
		const finished = vi.fn();
		subscriptions.push(
			subscribeBackgroundJobs((event) => {
				if (event.event === "finished") finished(event.job);
			}),
		);
		const result = await ops.exec("sleep 0.6 && echo late-output", process.cwd(), {
			onData: () => {},
			timeout: 0.2,
			timeoutAction: "background",
		});
		expect(result.backgrounded).toMatch(/^bg-/);

		await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(1), { timeout: 5000 });
		const job = finished.mock.calls[0]![0];
		expect(job.status).toBe("completed");
		expect(job.summary).toContain("late-output");
	});

	test("timeout with kill action still fails hard", async () => {
		await expect(
			ops.exec("sleep 0.6", process.cwd(), { onData: () => {}, timeout: 0.2, timeoutAction: "kill" }),
		).rejects.toThrow("timeout:");
	});
});
