import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import properLockfile from "proper-lockfile";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveProjectIdentity } from "../src/core/runtime/identity.ts";
import { RuntimeState } from "../src/core/runtime/state-db.ts";
import { TuiBridge } from "../src/modes/tui-bridge/server.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface PromptRecord {
	text: string;
	received: { time: number; timeZone: string; messageId: string } | undefined;
}

function setupBridge(delayGate?: { release: () => void }) {
	const root = mkdtempSync(join(tmpdir(), "neko-bridge-"));
	scratch.push(root);
	const stateDir = join(root, "sessions");
	mkdirSync(stateDir);
	writeFileSync(
		join(root, "models.json"),
		JSON.stringify({ providers: { demo: { models: [{ id: "demo-model" }] } } }),
	);
	const prompts: PromptRecord[] = [];
	const gate = delayGate ?? { release: () => {} };
	const bridge = new TuiBridge({
		defaultDirectory: root,
		modelsPath: join(root, "models.json"),
		stateDir,
		onLog: () => {},
		createAgent: async () => ({
			async prompt(text, options) {
				prompts.push({
					text,
					received: (options as { received?: PromptRecord["received"] } | undefined)?.received,
				});
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 50);
					gate.release = () => {
						clearTimeout(timer);
						resolve();
					};
				});
			},
			subscribe: () => () => {},
			async setModel() {},
			async abort() {},
			async waitForIdle() {},
			dispose() {},
		}),
	});
	return { bridge, root, stateDir, prompts, gate };
}

async function post(_bridge: TuiBridge, port: number, path: string, body: unknown): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("bridge message pipeline", () => {
	test("receipt is frozen at POST time and travels to the backend", async () => {
		const { bridge, root, prompts } = setupBridge();
		const port = await bridge.listen();
		try {
			const created = await post(bridge, port, "/api/session", { id: "ses_a", location: { directory: root } });
			expect(created.status).toBe(200);
			const before = Date.now();
			await post(bridge, port, "/api/session/ses_a/prompt", { id: "msg_a", text: "hello" });
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(prompts).toHaveLength(1);
			const received = prompts[0]!.received;
			expect(received?.messageId).toBe("msg_a");
			expect(received!.time).toBeGreaterThanOrEqual(before);
			expect(received!.time).toBeLessThanOrEqual(Date.now());
			expect(typeof received?.timeZone).toBe("string");
			// The message row carries the frozen snapshot and scope versions.
			const state = new RuntimeState(join(root, "sessions", "state.sqlite"));
			const row = state.getMessage("msg_a");
			expect(row?.state).toBe("done");
			expect(row?.received).toBe(received!.time);
			expect(row?.snapshot).toBeTruthy();
			state.close();
		} finally {
			await bridge.close();
		}
	});

	test("duplicate message id is an idempotent no-op", async () => {
		const { bridge, root, prompts } = setupBridge();
		const port = await bridge.listen();
		try {
			await post(bridge, port, "/api/session", { id: "ses_b", location: { directory: root } });
			const first = await post(bridge, port, "/api/session/ses_b/prompt", { id: "msg_dup", text: "once" });
			expect(first.status).toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 120));
			const second = await post(bridge, port, "/api/session/ses_b/prompt", { id: "msg_dup", text: "once" });
			expect(second.status).toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 120));
			expect(prompts).toHaveLength(1);
			const state = new RuntimeState(join(root, "sessions", "state.sqlite"));
			expect(state.listMessages("ses_b")).toHaveLength(1);
			// One user_query activity, not two.
			const events = state.activitiesSince(0, resolveProjectIdentity(root).projectId, 100000).events;
			expect(events.filter((event) => event.kind === "user_query")).toHaveLength(1);
			state.close();
		} finally {
			await bridge.close();
		}
	});

	test("queued message survives a restart with its original receipt", async () => {
		const gate: { release: () => void } = { release: () => {} };
		const { bridge, root, stateDir, prompts } = setupBridge(gate);
		const port = await bridge.listen();
		await post(bridge, port, "/api/session", { id: "ses_c", location: { directory: root } });
		const posted = Date.now();
		const response = await post(bridge, port, "/api/session/ses_c/prompt", { id: "msg_q", text: "queued" });
		expect(response.status).toBe(200);
		// Still executing: the gate blocks completion; close mid-run.
		await new Promise((resolve) => setTimeout(resolve, 20));
		await bridge.close();
		// Reopen from the same state directory.
		const prompts2: PromptRecord[] = [];
		const reopened = new TuiBridge({
			defaultDirectory: root,
			modelsPath: join(root, "models.json"),
			stateDir,
			onLog: () => {},
			createAgent: async () => ({
				async prompt(text, options) {
					prompts2.push({ text, received: (options as { received?: PromptRecord["received"] })?.received });
				},
				subscribe: () => () => {},
				async setModel() {},
				async abort() {},
				async waitForIdle() {},
				dispose() {},
			}),
		});
		const port2 = await reopened.listen();
		try {
			const inbox = (await (await fetch(`http://127.0.0.1:${port2}/api/session/ses_c/inbox`)).json()) as {
				data: unknown[];
			};
			expect(inbox.data).toHaveLength(0);
			const messages = (await (await fetch(`http://127.0.0.1:${port2}/api/session/ses_c/message`)).json()) as {
				data: unknown[];
			};
			expect(JSON.stringify(messages.data)).toContain("queued");
			const state = new RuntimeState(join(stateDir, "state.sqlite"));
			const row = state.getMessage("msg_q");
			expect(row?.received).toBeGreaterThanOrEqual(posted);
			state.close();
			expect(prompts).toHaveLength(1);
			expect(prompts2).toHaveLength(0);
		} finally {
			await reopened.close();
		}
	});

	test("cancelling an undelivered message keeps its snapshot claimable", async () => {
		const gate: { release: () => void } = { release: () => {} };
		const { bridge, root, prompts } = setupBridge(gate);
		const port = await bridge.listen();
		try {
			await post(bridge, port, "/api/session", { id: "ses_d", location: { directory: root } });
			await post(bridge, port, "/api/session/ses_d/prompt", { id: "msg_slow", text: "slow one" });
			await new Promise((resolve) => setTimeout(resolve, 10));
			// A follow-up queues behind the running one (steers would consume
			// live per A09); cancel it while it waits.
			await post(bridge, port, "/api/session/ses_d/prompt", {
				id: "msg_cancel",
				text: "cancel me",
				delivery: "queue",
			});
			const cancel = await fetch(`http://127.0.0.1:${port}/api/session/ses_d/inbox/msg_cancel`, {
				method: "DELETE",
			});
			expect(cancel.status).toBe(204);
			const state = new RuntimeState(join(root, "sessions", "state.sqlite"));
			expect(state.getMessage("msg_cancel")?.state).toBe("cancelled");
			// The frozen snapshot survives cancellation for compensation.
			expect(state.getMessage("msg_cancel")?.snapshot).toBeTruthy();
			gate.release();
			await new Promise((resolve) => setTimeout(resolve, 120));
			expect(prompts.map((p) => p.text)).toEqual(["slow one"]);
			state.close();
		} finally {
			gate.release();
			await bridge.close();
		}
	});

	test("sessions bind to real project identities and same-basename dirs stay distinct", async () => {
		const { bridge, root } = setupBridge();
		const port = await bridge.listen();
		try {
			const dirA = join(root, "service");
			const dirB = join(root, "nested", "service");
			mkdirSync(dirB, { recursive: true });
			await post(bridge, port, "/api/session", { id: "ses_p1", location: { directory: dirA } });
			await post(bridge, port, "/api/session", { id: "ses_p2", location: { directory: dirB } });
			const info1 = (await (await fetch(`http://127.0.0.1:${port}/api/session/ses_p1`)).json()) as {
				data: { projectID: string };
			};
			const info2 = (await (await fetch(`http://127.0.0.1:${port}/api/session/ses_p2`)).json()) as {
				data: { projectID: string };
			};
			expect(info1.data.projectID).not.toBe("pi");
			expect(info1.data.projectID).not.toBe(info2.data.projectID);
			const neko = (await (await fetch(`http://127.0.0.1:${port}/api/neko/sessions`)).json()) as {
				sessions: Array<{ id: string; project: { projectId: string } }>;
			};
			const projects = new Map(neko.sessions.map((entry) => [entry.id, entry.project.projectId]));
			expect(projects.get("ses_p1")).toBe(info1.data.projectID);
			expect(projects.get("ses_p2")).toBe(info2.data.projectID);
			const location = (await (
				await fetch(`http://127.0.0.1:${port}/api/location?location[directory]=${encodeURIComponent(dirA)}`)
			).json()) as { project: { id: string } };
			expect(location.project.id).toBe(info1.data.projectID);
		} finally {
			await bridge.close();
		}
	});

	test("a second bridge cannot run a session owned by another process", async () => {
		const gate: { release: () => void } = { release: () => {} };
		const { bridge, root, stateDir } = setupBridge(gate);
		const port = await bridge.listen();
		// Hold the native-session lock by hand, simulating a live peer run.
		const lockfile = properLockfile;
		const release = await lockfile.lock(join(stateDir, "ses_e.lock"), { realpath: false, stale: 60000 });
		try {
			await post(bridge, port, "/api/session", { id: "ses_e", location: { directory: root } });
			await post(bridge, port, "/api/session/ses_e/prompt", { id: "msg_e", text: "blocked" });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const state = new RuntimeState(join(stateDir, "state.sqlite"));
			const row = state.getMessage("msg_e");
			expect(["cancelled", "queued"]).toContain(row?.state);
			state.close();
		} finally {
			release();
			gate.release();
			await bridge.close();
		}
	});
});

describe("bridge tab switching", () => {
	test("switching sessions touches no model and logs no placeholder activity (Q02)", async () => {
		const { bridge, root } = setupBridge();
		const createAgent = vi.fn();
		// Rebuild with a counting createAgent to prove laziness.
		const counting = new TuiBridge({
			defaultDirectory: root,
			modelsPath: join(root, "models.json"),
			stateDir: join(root, "sessions"),
			onLog: () => {},
			createAgent: async (...args: unknown[]) => {
				createAgent(...(args as []));
				return {
					async prompt() {},
					subscribe: () => () => {},
					async setModel() {},
					async abort() {},
					async waitForIdle() {},
					dispose() {},
				};
			},
		});
		void bridge.close();
		const port = await counting.listen();
		try {
			const state = new RuntimeState(join(root, "sessions", "state.sqlite"));
			await post(counting, port, "/api/session", { id: "ses_t1", location: { directory: root } });
			await post(counting, port, "/api/session", { id: "ses_t2", location: { directory: root } });
			const beforeSeq = state.lastActivitySeq();
			// Round-trip every read/view path a tab switch uses.
			for (let round = 0; round < 3; round++) {
				await fetch(`http://127.0.0.1:${port}/api/session`);
				await fetch(`http://127.0.0.1:${port}/api/session/ses_t1/message`);
				await fetch(`http://127.0.0.1:${port}/api/session/ses_t2/message`);
				await post(counting, port, "/api/session/ses_t1/view", { idle: 0 });
				await post(counting, port, "/api/session/ses_t2/view", { idle: 0 });
			}
			expect(createAgent).not.toHaveBeenCalled();
			expect(state.lastActivitySeq()).toBe(beforeSeq);
			expect(state.listMessages("ses_t1")).toHaveLength(0);
			state.close();
		} finally {
			await counting.close();
		}
	});
});
