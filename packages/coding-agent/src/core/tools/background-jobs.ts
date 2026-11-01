/**
 * Background job registry: one process-wide table for work that outlives its
 * tool call — bash commands backgrounded explicitly or on timeout, and
 * background subagents.
 *
 * The registry is pure bookkeeping plus a listener port: tools register jobs
 * and report completion; the background-jobs extension installs a listener and
 * delivers finished results as queued messages (triggerTurn), so the model
 * wakes up with the output even when the user sends nothing. Nothing here
 * touches the UI or the model directly.
 */

export type BackgroundJobKind = "bash" | "subagent";

export interface BackgroundJob {
	id: string;
	sessionId?: string;
	kind: BackgroundJobKind;
	/** Short human label: the command line or agent name + task head. */
	label: string;
	startedAt: number;
	status: "running" | "completed" | "failed";
	/** Tail of the output, bounded, for the completion notification. */
	summary: string;
	/** Spool file carrying the full output, when one exists. */
	outputFile?: string;
	exitCode?: number | null;
	/**
	 * False once the result has reached its session, including foreground
	 * results. Completed jobs awaiting delivery survive an extension reload.
	 */
	notify?: boolean;
}

export type BackgroundJobEvent = { job: BackgroundJob; event: "started" | "finished" };

type JobListener = (event: BackgroundJobEvent) => void;

const jobs = new Map<string, BackgroundJob>();
const listeners = new Set<JobListener>();
let counter = 0;

/** Subscribe until the owning session shuts down or reloads. */
export function subscribeBackgroundJobs(listener: JobListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function listBackgroundJobs(sessionId?: string): BackgroundJob[] {
	return [...jobs.values()].filter((job) => sessionId === undefined || job.sessionId === sessionId);
}

export function hasPendingBackgroundJobs(sessionId: string): boolean {
	return listBackgroundJobs(sessionId).some((job) => job.status === "running" || job.notify !== false);
}

/** Register a running job and notify the listener. */
export function registerBackgroundJob(input: {
	sessionId?: string;
	kind: BackgroundJobKind;
	label: string;
	outputFile?: string;
	notify?: boolean;
}): BackgroundJob {
	counter += 1;
	const job: BackgroundJob = {
		id: `bg-${counter}`,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		kind: input.kind,
		label: input.label,
		startedAt: Date.now(),
		status: "running",
		summary: "",
		...(input.outputFile ? { outputFile: input.outputFile } : {}),
		...(input.notify === false ? { notify: false } : {}),
	};
	jobs.set(job.id, job);
	for (const listener of listeners) listener({ job, event: "started" });
	return job;
}

/** Mark a job finished (exactly once) and notify the listener. */
export function finishBackgroundJob(
	id: string,
	result: { status: "completed" | "failed"; summary: string; exitCode?: number | null; outputFile?: string },
): BackgroundJob | undefined {
	const job = jobs.get(id);
	if (!job || job.status !== "running") return job;
	job.status = result.status;
	job.summary = result.summary;
	job.exitCode = result.exitCode;
	if (result.outputFile) job.outputFile = result.outputFile;
	for (const listener of listeners) listener({ job, event: "finished" });
	return job;
}

/** Drop finished jobs from the table (used by tests; running jobs stay). */
export function clearFinishedBackgroundJobs(): void {
	for (const [id, job] of jobs) if (job.status !== "running") jobs.delete(id);
}
