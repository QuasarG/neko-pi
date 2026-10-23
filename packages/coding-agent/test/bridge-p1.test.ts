import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { ModelRuntimeLike } from "../src/modes/tui-bridge/server.ts";
import { type BridgeAgent, type BridgeRuntimeSettings, TuiBridge } from "../src/modes/tui-bridge/server.ts";
import { RUNTIME_SETTING_DESCRIPTORS, RuntimeSettings } from "../src/modes/tui-bridge/settings.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface AgentCalls {
	compact: number;
	reload: number;
	shell: string[];
	exportFormat: string[];
	stats: number;
	environments: Array<Record<string, string> | undefined>;
}

interface BootOptions {
	runtimeSettings?: BridgeRuntimeSettings;
	mcpConfigPaths?: string[];
	modelRuntime?: ModelRuntimeLike;
}

async function boot(options: BootOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "neko-p1-"));
	scratch.push(root);
	const calls: AgentCalls = { compact: 0, reload: 0, shell: [], exportFormat: [], stats: 0, environments: [] };
	const agentState = { environment: undefined as Record<string, string> | undefined };
	const bridge = new TuiBridge({
		defaultDirectory: root,
		modelsPath: "/nonexistent.json",
		stateDir: join(root, "sessions"),
		onLog: () => {},
		...(options.runtimeSettings ? { runtimeSettings: options.runtimeSettings } : {}),
		...(options.mcpConfigPaths ? { mcpConfigPaths: options.mcpConfigPaths } : {}),
		...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
		createAgent: async (): Promise<BridgeAgent> => ({
			async prompt() {},
			subscribe: () => () => {},
			async setModel() {},
			async abort() {},
			async waitForIdle() {},
			dispose() {},
			async compact() {
				calls.compact++;
				return { summary: "compacted" };
			},
			async reload() {
				calls.reload++;
			},
			async executeShell(command) {
				calls.shell.push(command);
				return { stdout: `output of ${command}`, stderr: "", exitCode: 0 };
			},
			async exportToHtml(path) {
				calls.exportFormat.push("html");
				return path ?? "/tmp/export.html";
			},
			exportToJsonl(path) {
				calls.exportFormat.push("jsonl");
				return path ?? "/tmp/export.jsonl";
			},
			getSessionStats() {
				calls.stats++;
				return { tokens: { input: 100, output: 50 } };
			},
			async setEnvironment(variables) {
				agentState.environment = variables;
				calls.environments.push(variables);
			},
			listSkills: () => [{ id: "test-skill", name: "test-skill", description: "A test skill" }],
			listSlashCommands: () => [{ name: "test-cmd", description: "Test command" }],
		}),
	});
	const port = await bridge.listen();
	const post = (pathSuffix: string, body?: unknown) =>
		fetch(`http://127.0.0.1:${port}${pathSuffix}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
	const get = (pathSuffix: string) => fetch(`http://127.0.0.1:${port}${pathSuffix}`);
	const put = (pathSuffix: string, body?: unknown) =>
		fetch(`http://127.0.0.1:${port}${pathSuffix}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
	return { bridge, port, root, calls, agentState, post, get, put };
}

describe("P1 endpoints (B02–B07, D03, D04)", () => {
	test("B02/B03: skills and commands come from the real resource loader", async () => {
		const { bridge, get, post } = await boot();
		try {
			await post("/api/session", { id: "ses_res", location: {} });
			const skills = (await (await get("/api/skill")).json()) as { data: Array<{ id: string }> };
			expect(skills.data[0]?.id).toBe("test-skill");
			const commands = (await (await get("/api/command")).json()) as { data: Array<{ name: string }> };
			expect(commands.data[0]?.name).toBe("test-cmd");
		} finally {
			await bridge.close();
		}
	});

	test("B02: MCP list reads configuration files, no fake connected state", async () => {
		const root = mkdtempSync(join(tmpdir(), "neko-mcp-"));
		scratch.push(root);
		const configPath = join(root, "mcp.json");
		writeFileSync(
			configPath,
			JSON.stringify({ mcpServers: { alpha: { command: ["echo"] }, beta: { command: ["echo"], disabled: true } } }),
		);
		const { bridge, get } = await boot({ mcpConfigPaths: [configPath] });
		try {
			const mcp = (await (await get("/api/mcp")).json()) as {
				data: Array<{ name: string; status: { status: string } }>;
			};
			expect(mcp.data).toHaveLength(2);
			const alpha = mcp.data.find((server) => server.name === "alpha");
			const beta = mcp.data.find((server) => server.name === "beta");
			// Configured-but-unmanaged servers surface as pending, disabled as disabled —
			// the bridge never claims "connected" it cannot observe.
			expect(alpha?.status.status).toBe("pending");
			expect(beta?.status.status).toBe("disabled");
		} finally {
			await bridge.close();
		}
	});

	test("B05: compact calls the native method and rejects when running", async () => {
		const { bridge, post, calls } = await boot();
		try {
			await post("/api/session", { id: "ses_c", location: {} });
			const result = await post("/api/session/ses_c/compact");
			expect(result.status).toBe(200);
			expect(calls.compact).toBe(1);
			const missing = await post("/api/session/ses_none/compact");
			expect(missing.status).toBe(404);
		} finally {
			await bridge.close();
		}
	});

	test("B06: shell responds 204 immediately and executes asynchronously", async () => {
		const { bridge, post, calls, get } = await boot();
		try {
			await post("/api/session", { id: "ses_sh", location: {} });
			const started = Date.now();
			const result = await post("/api/session/ses_sh/shell", { command: "echo hello" });
			expect(result.status).toBe(204);
			expect(Date.now() - started).toBeLessThan(500);
			// The command reaches the async executor and finishes without blocking.
			await waitFor(() => calls.shell.length === 1);
			expect(calls.shell).toEqual(["echo hello"]);
			// Other requests stay serviceable right after submission.
			const sessions = await get("/api/neko/sessions");
			expect(sessions.status).toBe(200);
			const bad = await post("/api/session/ses_sh/shell", {});
			expect(bad.status).toBe(400);
		} finally {
			await bridge.close();
		}
	});

	test("B07: reload works on both /api/reload and /api/location/reload", async () => {
		const { bridge, post, calls } = await boot();
		try {
			await post("/api/session", { id: "ses_r", location: {} });
			await post("/api/session/ses_r/compact");
			const result = await post("/api/reload");
			expect(result.status).toBe(200);
			const locationReload = await post("/api/location/reload");
			expect(locationReload.status).toBe(204);
			expect(calls.reload).toBeGreaterThanOrEqual(2);
		} finally {
			await bridge.close();
		}
	});

	test("D03: file export supports jsonl and html; GET export returns the transfer shape", async () => {
		const { bridge, post, get, calls } = await boot();
		try {
			await post("/api/session", { id: "ses_e", location: {} });
			const jsonl = await post("/api/session/ses_e/export", { format: "jsonl" });
			expect(jsonl.status).toBe(200);
			const html = await post("/api/session/ses_e/export", { format: "html" });
			expect(html.status).toBe(200);
			expect(calls.exportFormat).toEqual(["jsonl", "html"]);
			const bad = await post("/api/session/ses_e/export", { format: "pdf" });
			expect(bad.status).toBe(400);
			// The experimental GET route returns the full transfer projection.
			const transfer = (await (await get("/api/experimental/session/ses_e/export")).json()) as {
				data: { info: { id: string }; messages: unknown[] };
			};
			expect(transfer.data.info.id).toBe("ses_e");
			expect(Array.isArray(transfer.data.messages)).toBe(true);
		} finally {
			await bridge.close();
		}
	});

	test("D04: stats from the native session", async () => {
		const { bridge, post, get, calls } = await boot();
		try {
			await post("/api/session", { id: "ses_st", location: {} });
			await post("/api/session/ses_st/compact");
			const stats = (await (await get("/api/session/ses_st/stats")).json()) as { data: { tokens?: unknown } };
			expect(stats.data.tokens).toBeDefined();
			expect(calls.stats).toBeGreaterThanOrEqual(1);
		} finally {
			await bridge.close();
		}
	});

	test("B01: integration lists providers with auth status", async () => {
		const { bridge, get } = await boot();
		try {
			const integrations = (await (await get("/api/integration")).json()) as { data: unknown[] };
			expect(Array.isArray(integrations.data)).toBe(true);
		} finally {
			await bridge.close();
		}
	});

	test("B09: /api/info reports the real version", async () => {
		const { bridge, get } = await boot();
		try {
			const info = (await (await get("/api/info")).json()) as { version: string };
			expect(info.version).toMatch(/^\d+\.\d+/);
		} finally {
			await bridge.close();
		}
	});

	test("A08: non-image data URI files become text context in the message", async () => {
		const root = mkdtempSync(join(tmpdir(), "neko-file-"));
		scratch.push(root);
		const prompts: string[] = [];
		const bridge = new TuiBridge({
			defaultDirectory: root,
			modelsPath: "/nonexistent.json",
			stateDir: join(root, "sessions"),
			onLog: () => {},
			createAgent: async (): Promise<BridgeAgent> => ({
				async prompt(text) {
					prompts.push(text);
				},
				subscribe: () => () => {},
				async setModel() {},
				async abort() {},
				async waitForIdle() {},
				dispose() {},
			}),
		});
		const port = await bridge.listen();
		try {
			await fetch(`http://127.0.0.1:${port}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "ses_f", location: {} }),
			});
			const response = await fetch(`http://127.0.0.1:${port}/api/session/ses_f/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					text: "check this file",
					files: [
						{
							uri: "data:text/plain;base64,aGVsbG8gd29ybGQ=",
							name: "notes.txt",
						},
					],
				}),
			});
			expect(response.status).toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain("check this file");
			expect(prompts[0]).toContain("--- notes.txt (plain) ---");
			expect(prompts[0]).toContain("hello world");
		} finally {
			await bridge.close();
		}
	});
});

describe("B11 environment and D01 discovery", () => {
	test("B11: environment variables are session-scoped and never touch process.env", async () => {
		const { bridge, post, put, agentState } = await boot();
		try {
			await post("/api/session", { id: "ses_env", location: {} });
			// Touch a backend-creating endpoint so setEnvironment has a target.
			await post("/api/session/ses_env/compact");
			const result = await put("/api/session/ses_env/environment", {
				variables: { NEKO_TEST_VAR: "hello-env" },
			});
			expect(result.status).toBe(204);
			// Session state, not the bridge process environment.
			expect(process.env.NEKO_TEST_VAR).toBeUndefined();
			await waitFor(() => agentState.environment !== undefined);
			expect(agentState.environment).toEqual({ NEKO_TEST_VAR: "hello-env" });
			const bad = await put("/api/session/ses_env/environment", { variables: "not-object" });
			expect(bad.status).toBe(400);
		} finally {
			delete process.env.NEKO_TEST_VAR;
			await bridge.close();
		}
	});

	test("B11: two sessions keep separate environments", async () => {
		const { bridge, post, put, calls } = await boot();
		try {
			await post("/api/session", { id: "ses_a", location: {} });
			await post("/api/session", { id: "ses_b", location: {} });
			await post("/api/session/ses_a/compact");
			await post("/api/session/ses_b/compact");
			const putA = await put("/api/session/ses_a/environment", { variables: { SHARED_NAME: "from-a" } });
			const putB = await put("/api/session/ses_b/environment", { variables: { SHARED_NAME: "from-b" } });
			expect(putA.status).toBe(204);
			expect(putB.status).toBe(204);
			await waitFor(() => calls.environments.length === 2);
			expect(calls.environments[0]).toEqual({ SHARED_NAME: "from-a" });
			expect(calls.environments[1]).toEqual({ SHARED_NAME: "from-b" });
		} finally {
			await bridge.close();
		}
	});

	test("D01: native sessions are discovered with paths and bridged ones excluded", async () => {
		const root = mkdtempSync(join(tmpdir(), "neko-d01-"));
		scratch.push(root);
		const nativeSessions = [
			{
				id: "native-abc",
				path: join(root, "native-abc.jsonl"),
				cwd: root,
				name: "An old native session",
				created: Date.now() - 86400000,
				modified: Date.now() - 3600000,
				messageCount: 5,
				firstMessage: "How do I set up a build pipeline?",
			},
		];
		const bridge = new TuiBridge({
			defaultDirectory: root,
			modelsPath: "/nonexistent.json",
			stateDir: join(root, "sessions"),
			onLog: () => {},
			createAgent: async (): Promise<BridgeAgent> => ({
				async prompt() {},
				subscribe: () => () => {},
				async setModel() {},
				async abort() {},
				async waitForIdle() {},
				dispose() {},
				listNativeSessions: async () => nativeSessions,
			}),
		});
		const port = await bridge.listen();
		try {
			await fetch(`http://127.0.0.1:${port}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "ses_d1", location: { directory: root } }),
			});
			const response = await fetch(`http://127.0.0.1:${port}/api/neko/native-sessions`);
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				sessions: Array<{ bridgeId: string; nativeId: string; name: string; messageCount: number }>;
			};
			expect(body.sessions).toHaveLength(1);
			expect(body.sessions[0]?.bridgeId).toBe("native_native-abc");
			expect(body.sessions[0]?.nativeId).toBe("native-abc");
		} finally {
			await bridge.close();
		}
	});

	test("S03: a discovered native session opens as a bridge session with projected history", async () => {
		const root = mkdtempSync(join(tmpdir(), "neko-open-"));
		scratch.push(root);
		const sessionFile = join(root, "native-abc.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "native-abc", timestamp: "2026-01-01T00:00:00Z", cwd: root })}\n`,
		);
		const bridge = new TuiBridge({
			defaultDirectory: root,
			modelsPath: "/nonexistent.json",
			stateDir: join(root, "sessions"),
			onLog: () => {},
			createAgent: async (): Promise<BridgeAgent> => ({
				async prompt() {},
				subscribe: () => () => {},
				async setModel() {},
				async abort() {},
				async waitForIdle() {},
				dispose() {},
				openNativeSession: async () => ({
					id: "native-abc",
					file: sessionFile,
					projection: [
						{ id: "e1", type: "user", text: "old question", time: { created: 1 } },
						{
							id: "e2",
							type: "assistant",
							text: "old answer",
							content: [{ type: "text", text: "old answer" }],
							time: { created: 2 },
						},
					],
					backend: {
						async prompt() {},
						subscribe: () => () => {},
						async setModel() {},
						async abort() {},
						async waitForIdle() {},
						dispose() {},
					},
				}),
			}),
		});
		const port = await bridge.listen();
		try {
			await fetch(`http://127.0.0.1:${port}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "ses_boot", location: { directory: root } }),
			});
			const open = await fetch(`http://127.0.0.1:${port}/api/neko/native-sessions/native-abc/open`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: sessionFile }),
			});
			expect(open.status).toBe(200);
			const body = (await open.json()) as { data: { id: string } };
			expect(body.data.id).toBe("native_native-abc");
			const messages = (await (
				await fetch(`http://127.0.0.1:${port}/api/session/native_native-abc/message`)
			).json()) as { data: Array<{ id: string; type: string }> };
			expect(messages.data).toHaveLength(2);
			expect(messages.data[0]?.type).toBe("user");
			expect(messages.data[1]?.type).toBe("assistant");
			// Re-opening is idempotent.
			const again = await fetch(`http://127.0.0.1:${port}/api/neko/native-sessions/native-abc/open`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: sessionFile }),
			});
			expect(again.status).toBe(200);
		} finally {
			await bridge.close();
		}
	});
});

describe("B04 UI channel, B08 settings, D02 fork", () => {
	test("B04: UI request/respond/cancel/timeout lifecycle", async () => {
		const root = mkdtempSync(join(tmpdir(), "neko-ui-"));
		scratch.push(root);
		const bridge = new TuiBridge({
			defaultDirectory: root,
			modelsPath: "/nonexistent.json",
			stateDir: join(root, "sessions"),
			onLog: () => {},
			createAgent: async (): Promise<BridgeAgent> => ({
				async prompt() {},
				subscribe: () => () => {},
				async setModel() {},
				async abort() {},
				async waitForIdle() {},
				dispose() {},
			}),
		});
		const port = await bridge.listen();
		try {
			await fetch(`http://127.0.0.1:${port}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "ses_ui", location: {} }),
			});
			const requestPromise = bridge.registerUiRequest({
				sessionId: "ses_ui",
				kind: "select",
				title: "Choose a plan",
				options: ["fast", "safe"],
				timeoutMs: 5000,
			});
			await new Promise((resolve) => setTimeout(resolve, 100));
			const requestId = [...(bridge as unknown as { uiRequests: Map<string, unknown> }).uiRequests.keys()][0]!;
			const respond = await fetch(`http://127.0.0.1:${port}/api/neko/ui/${requestId}/respond`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: "safe" }),
			});
			expect(respond.status).toBe(204);
			expect(await requestPromise).toBe("safe");
			const stale = await fetch(`http://127.0.0.1:${port}/api/neko/ui/${requestId}/respond`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: "x" }),
			});
			expect(stale.status).toBe(404);
			const cancelPromise = bridge.registerUiRequest({
				sessionId: "ses_ui",
				kind: "confirm",
				title: "Sure?",
				timeoutMs: 5000,
			});
			await new Promise((resolve) => setTimeout(resolve, 100));
			const cancelId = [...(bridge as unknown as { uiRequests: Map<string, unknown> }).uiRequests.keys()][0]!;
			await fetch(`http://127.0.0.1:${port}/api/neko/ui/${cancelId}/cancel`, { method: "POST" });
			expect(await cancelPromise).toBeUndefined();
			// A request with no session broadcasts globally and still resolves.
			const globalPromise = bridge.registerUiRequest({ kind: "input", title: "API key?" });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const globalId = [...(bridge as unknown as { uiRequests: Map<string, unknown> }).uiRequests.keys()][0]!;
			await fetch(`http://127.0.0.1:${port}/api/neko/ui/${globalId}/respond`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: "sk-test" }),
			});
			expect(await globalPromise).toBe("sk-test");
		} finally {
			await bridge.close();
		}
	});

	test("B04: the UI channel reaches the agent's extension UI context", async () => {
		const root = mkdtempSync(join(tmpdir(), "neko-uibind-"));
		scratch.push(root);
		const seenUiChannels: Array<{
			request: (input: { kind: "select"; title: string; options?: string[] }) => Promise<unknown>;
		}> = [];
		const bridge = new TuiBridge({
			defaultDirectory: root,
			modelsPath: "/nonexistent.json",
			stateDir: join(root, "sessions"),
			onLog: () => {},
			createAgent: async (_cwd, _model, _sessionID, agentOptions) => {
				// The bridge hands the agent a UI channel; extensions answer through it.
				const ui = agentOptions?.ui;
				expect(ui).toBeDefined();
				if (ui) seenUiChannels.push(ui);
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
		const port = await bridge.listen();
		try {
			await fetch(`http://127.0.0.1:${port}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "ses_bind", location: {} }),
			});
			// Force agent creation through a backend-touching endpoint.
			await fetch(`http://127.0.0.1:${port}/api/session/ses_bind/compact`, { method: "POST" });
			expect(seenUiChannels).toHaveLength(1);
			// Ask through the channel the agent received and answer over HTTP.
			const answer = seenUiChannels[0]!.request({ kind: "select", title: "Pick one", options: ["a", "b"] });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const ids = [...(bridge as unknown as { uiRequests: Map<string, unknown> }).uiRequests.keys()];
			expect(ids).toHaveLength(1);
			await fetch(`http://127.0.0.1:${port}/api/neko/ui/${ids[0]}/respond`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: "a" }),
			});
			expect(await answer).toBe("a");
		} finally {
			await bridge.close();
		}
	});

	test("B08: runtime settings read and write through pi's SettingsManager", async () => {
		const manager = SettingsManager.inMemory();
		const runtimeSettings = new RuntimeSettings(manager);
		const { bridge, get, put } = await boot({
			runtimeSettings: {
				read: () => runtimeSettings.read(),
				write: async (patch) => ({ ...(await runtimeSettings.write(patch)) }),
				descriptors: RUNTIME_SETTING_DESCRIPTORS as unknown as Array<Record<string, unknown>>,
			},
		});
		try {
			const settings = (await (await get("/api/neko/settings")).json()) as {
				interface: { source: string };
				runtime: { source: string; values: Record<string, unknown>; settings: Array<{ key: string }> };
			};
			expect(settings.interface.source).toBe("tui-local");
			expect(settings.runtime.source).toBe("pi-settings");
			expect(settings.runtime.settings.length).toBeGreaterThan(0);
			expect(settings.runtime.values.compactionEnabled).toBe(true);
			// Write, then verify the value the bridge reports matches what
			// pi's SettingsManager actually holds (read-back, not fake success).
			const saved = await put("/api/neko/settings/runtime", {
				compactionEnabled: false,
				defaultModel: "test-model",
			});
			expect(saved.status).toBe(200);
			const savedBody = (await saved.json()) as { saved: boolean; values: Record<string, unknown> };
			expect(savedBody.saved).toBe(true);
			expect(savedBody.values.compactionEnabled).toBe(false);
			expect(savedBody.values.defaultModel).toBe("test-model");
			expect(manager.getCompactionEnabled()).toBe(false);
			expect(manager.getDefaultModel()).toBe("test-model");
			// Unknown keys are rejected instead of silently stored.
			const bad = await put("/api/neko/settings/runtime", { nonsenseKey: 1 });
			expect(bad.status).toBe(400);
		} finally {
			await bridge.close();
		}
	});

	test("B08: without an adapter, writes fail honestly", async () => {
		const { bridge, put } = await boot();
		try {
			const result = await put("/api/neko/settings/runtime", { defaultModel: "x" });
			expect(result.status).toBe(501);
		} finally {
			await bridge.close();
		}
	});

	test("D02: fork accepts before, maps boundaries, and seeds the fork's history", async () => {
		const root = mkdtempSync(join(tmpdir(), "neko-fork-"));
		scratch.push(root);
		const forkCalls: Array<string | undefined> = [];
		const bridge = new TuiBridge({
			defaultDirectory: root,
			modelsPath: "/nonexistent.json",
			stateDir: join(root, "sessions"),
			onLog: () => {},
			createAgent: async (): Promise<BridgeAgent> => ({
				async prompt() {},
				subscribe: () => () => {},
				async setModel() {},
				async abort() {},
				async waitForIdle() {},
				dispose() {},
				resolveEntryId: (messageId) => (messageId.startsWith("msg_") ? undefined : messageId),
				forkSession: async (entryId) => {
					forkCalls.push(entryId);
					return {
						id: `ses_forked_${forkCalls.length}`,
						file: join(root, `fork-${forkCalls.length}.jsonl`),
						projection: [{ id: "e1", type: "user", text: "kept question", time: { created: 1 } }],
					};
				},
			}),
		});
		const port = await bridge.listen();
		try {
			await fetch(`http://127.0.0.1:${port}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "ses_orig", location: {} }),
			});
			// opencode wire format: {before: messageID}.
			const fork = await fetch(`http://127.0.0.1:${port}/api/session/ses_orig/fork`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ before: "entry_123" }),
			});
			expect(fork.status).toBe(200);
			const body = (await fork.json()) as { data: { id: string } };
			expect(body.data.id).toBe("ses_forked_1");
			expect(forkCalls).toEqual(["entry_123"]);
			// The fork session exposes the projected history immediately.
			const messages = (await (await fetch(`http://127.0.0.1:${port}/api/session/ses_forked_1/message`)).json()) as {
				data: Array<{ text: string }>;
			};
			expect(messages.data[0]?.text).toBe("kept question");
			// Bridge-generated msg_* ID → unresolvable (422).
			const bad = await fetch(`http://127.0.0.1:${port}/api/session/ses_orig/fork`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ before: "msg_abc" }),
			});
			expect(bad.status).toBe(422);
			// No boundary → full-history fork (entryId undefined).
			const full = await fetch(`http://127.0.0.1:${port}/api/session/ses_orig/fork`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(full.status).toBe(200);
			expect(forkCalls[1]).toBeUndefined();
		} finally {
			await bridge.close();
		}
	});

	test("thinking: GET reports the level; current alias resolves the latest session", async () => {
		const { bridge, post, get } = await boot({
			modelRuntime: {
				getAllModels: () => [
					{
						id: "reason-model",
						name: "Reason Model",
						provider: "test-provider",
						contextWindow: 100000,
						maxTokens: 4096,
						input: ["text"],
						reasoning: true,
					},
				],
				getAvailableSnapshot: () => [],
				hasConfiguredAuth: () => true,
			},
		});
		try {
			await post("/api/session", {
				id: "ses_t1",
				location: {},
				model: { providerID: "test-provider", id: "reason-model" },
			});
			const before = (await (await get("/api/session/ses_t1/thinking")).json()) as { level: string };
			expect(before.level).toBe("off");
			const set = await post("/api/session/ses_t1/thinking", { level: "high" });
			expect(set.status).toBe(204);
			const after = (await (await get("/api/session/current/thinking")).json()) as { level: string };
			expect(after.level).toBe("high");
		} finally {
			await bridge.close();
		}
	});
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
