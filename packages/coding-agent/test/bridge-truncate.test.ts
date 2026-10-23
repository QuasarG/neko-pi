import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RuntimeState } from "../src/core/runtime/state-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type BridgeAgent, TuiBridge } from "../src/modes/tui-bridge/server.ts";
import { truncateNativeSession } from "../src/modes/tui-bridge/truncate.ts";
import { createHarness, getUserTexts } from "./suite/harness.ts";

const scratch: string[] = [];
beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "neko-truncate-home-"));
	scratch.push(root);
	vi.stubEnv("NEKO_PI_HOME", root);
});
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("native truncation preserves identity and parent chain and removes failed turns from live context", async () => {
	const root = mkdtempSync(join(tmpdir(), "neko-truncate-"));
	scratch.push(root);
	const manager = SessionManager.create(root, root);
	const harness = await createHarness({ sessionManager: manager });
	try {
		harness.setResponses([fauxAssistantMessage("first answer")]);
		await harness.session.prompt("keep me");
		const target = manager.appendMessage({ role: "user", content: "remove me", timestamp: Date.now() });
		harness.session.refreshContext();
		const sessionId = manager.getSessionId();
		await truncateNativeSession(harness.session, target);
		expect(manager.getSessionId()).toBe(sessionId);
		expect(getUserTexts(harness)).toEqual(["keep me"]);
		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(reopened.getEntries().some((entry) => entry.id === target)).toBe(false);
		for (const entry of reopened.getEntries()) {
			if (entry.parentId) expect(reopened.getEntry(entry.parentId)).toBeDefined();
		}
		harness.setResponses([fauxAssistantMessage("new answer")]);
		await harness.session.prompt("replacement");
		expect(getUserTexts(harness)).toEqual(["keep me", "replacement"]);
	} finally {
		harness.cleanup();
	}
});

test("first-turn truncation yields an empty context; failed reload restores file and live context", async () => {
	const root = mkdtempSync(join(tmpdir(), "neko-truncate-"));
	scratch.push(root);
	const manager = SessionManager.create(root, root);
	const harness = await createHarness({ sessionManager: manager });
	try {
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("first question");
		const target = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!;
		const file = manager.getSessionFile()!;
		const original = readFileSync(file, "utf8");
		const reload = vi.spyOn(harness.session, "reload").mockRejectedValueOnce(new Error("reload failed"));
		await expect(truncateNativeSession(harness.session, target.id)).rejects.toThrow("reload failed");
		expect(readFileSync(file, "utf8")).toBe(original);
		expect(getUserTexts(harness)).toEqual(["first question"]);
		reload.mockRestore();
		await expect(truncateNativeSession(harness.session, "missing")).rejects.toThrow("active branch");
		expect(readFileSync(file, "utf8")).toBe(original);
		await truncateNativeSession(harness.session, target.id);
		expect(getUserTexts(harness)).toEqual([]);
		expect(
			SessionManager.open(file)
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
				),
		).toEqual([]);
	} finally {
		harness.cleanup();
	}
});

test("truncating a branched turn preserves earlier branches and reopens at the selected parent", async () => {
	const root = mkdtempSync(join(tmpdir(), "neko-truncate-"));
	scratch.push(root);
	const manager = SessionManager.create(root, root);
	const first = manager.appendMessage({ role: "user", content: "shared", timestamp: 1 });
	const other = manager.appendMessage({ role: "user", content: "other branch", timestamp: 2 });
	manager.branch(first);
	const target = manager.appendMessage({ role: "user", content: "remove branch", timestamp: 3 });
	const harness = await createHarness({ sessionManager: manager });
	try {
		await truncateNativeSession(harness.session, target);
		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(reopened.getEntry(other)).toBeDefined();
		expect(reopened.getEntry(target)).toBeUndefined();
		expect(
			reopened
				.getBranch()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.id),
		).toEqual([first]);
		expect(getUserTexts(harness)).toEqual(["shared"]);
	} finally {
		harness.cleanup();
	}
});

test("a provider-rejected turn can be edited in place and replaced without retaining the rejected context", async () => {
	const root = mkdtempSync(join(tmpdir(), "neko-truncate-"));
	scratch.push(root);
	const manager = SessionManager.create(root, join(root, "native"));
	const harness = await createHarness({ sessionManager: manager, settings: { retry: { enabled: false } } });
	harness.setResponses([
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: '{"error":{"code":"1301","type":"invalid_request_error"}}',
		}),
	]);
	const bridge = new TuiBridge({
		stateDir: join(root, "bridge"),
		defaultDirectory: root,
		modelsPath: "/missing",
		onLog: () => {},
		createAgent: async () => ({
			prompt: (text, options) => harness.session.prompt(text, options),
			subscribe: (listener) => harness.session.subscribe(listener),
			abort: () => harness.session.abort(),
			waitForIdle: () => harness.session.waitForIdle(),
			dispose: () => {},
			setModel: async () => {},
			getSessionId: () => manager.getSessionId(),
			getMessageEntryId: (message) => harness.session.getEntryIdForMessage(message as never),
			truncate: (entryId) => truncateNativeSession(harness.session, entryId),
		}),
	});
	const port = await bridge.listen();
	const base = `http://127.0.0.1:${port}/api/session`;
	const post = (path: string, body: unknown) =>
		fetch(`${base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	try {
		await post("", { id: "ses_failed" });
		await post("/ses_failed/prompt", { id: "msg_rejected", text: "rejected question" });
		await vi.waitFor(async () => {
			const result = await (await fetch(`${base}/active`)).json();
			expect(result).toEqual({ data: {} });
		});
		expect((await post("/ses_failed/truncate", { messageID: "msg_rejected" })).status).toBe(200);
		expect(getUserTexts(harness)).toEqual([]);
		harness.setResponses([fauxAssistantMessage("replacement answer")]);
		await post("/ses_failed/prompt", { id: "msg_replacement", text: "replacement question" });
		await vi.waitFor(() => expect(getUserTexts(harness)).toEqual(["replacement question"]));
		expect(manager.getSessionId()).toBe(harness.session.sessionId);
	} finally {
		await bridge.close();
		harness.cleanup();
	}
});

test("bridge truncation cuts projection and mapping, invalidates background receipts, and blocks concurrent sends", async () => {
	const root = mkdtempSync(join(tmpdir(), "neko-truncate-"));
	scratch.push(root);
	writeFileSync(
		join(root, "ses_edit.json"),
		JSON.stringify({
			id: "ses_edit",
			directory: root,
			agent: "build",
			title: "test",
			created: 1,
			updated: 2,
			idle: 2,
			messages: [],
			seq: 0,
			history: [
				{ id: "m1", type: "user", text: "keep", time: { created: 1 } },
				{ id: "m2", type: "user", text: "edit", time: { created: 2 } },
				{ id: "m3", type: "idle", outcome: "failed", time: { created: 3 } },
			],
			entryByMessage: { m1: "e1", m2: "e2" },
		}),
	);
	const state = new RuntimeState(":memory:");
	state.markReceipt("native", "memory_catalog", 4, "persona");
	state.markReceipt("native", "continuity", 123, "persona");
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const truncate = vi.fn(async () => {
		started.resolve();
		await gate.promise;
	});
	const bridge = new TuiBridge({
		state,
		stateDir: root,
		defaultDirectory: root,
		modelsPath: "/missing",
		onLog: () => {},
		createAgent: async (): Promise<BridgeAgent> => ({
			prompt: async () => {},
			subscribe: () => () => {},
			abort: async () => {},
			waitForIdle: async () => {},
			dispose: () => {},
			setModel: async () => {},
			truncate,
			getSessionId: () => "native",
		}),
	});
	const port = await bridge.listen();
	const post = (sub: string, body: unknown) =>
		fetch(`http://127.0.0.1:${port}/api/session/ses_edit/${sub}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	try {
		expect((await post("truncate", { messageID: "missing" })).status).toBe(422);
		const pending = post("truncate", { messageID: "m2" });
		await started.promise;
		expect((await post("prompt", { text: "racing send" })).status).toBe(409);
		expect((await post("truncate", { messageID: "m1" })).status).toBe(409);
		gate.resolve();
		expect((await pending).status).toBe(200);
		expect(truncate).toHaveBeenCalledWith("e2");
		const saved = JSON.parse(readFileSync(join(root, "ses_edit.json"), "utf8")) as {
			history: Array<{ id: string }>;
			entryByMessage: Record<string, string>;
		};
		expect(saved.history.map((item) => item.id)).toEqual(["m1"]);
		expect(saved.entryByMessage).toEqual({ m1: "e1" });
		expect(state.getReceipt("native", "memory_catalog", "persona")?.version).toBe(-1);
		expect(state.getReceipt("native", "continuity", "persona")?.version).toBe(-1);
	} finally {
		gate.resolve();
		await bridge.close();
		state.close();
	}
});
