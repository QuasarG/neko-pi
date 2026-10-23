import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RuntimeState } from "../src/core/runtime/state-db.ts";
import { type BridgeAgent, TuiBridge } from "../src/modes/tui-bridge/server.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * POST /thinking judged reasoning by the session's SAVED model only. A
 * session created without an explicit model (several TUI create paths) or
 * whose saved model vanished from models.json has no entry — the check read
 * that as "unreasoning" and returned 415 while the session actually ran (and
 * reasoned) on the default model. The capability must follow the model the
 * session executes on.
 */
describe("thinking level on sessions without an explicit model", () => {
	const modelsJson = (reasoning: boolean) => ({
		providers: {
			zai: {
				models: [
					{ id: "glm-5.3", reasoning, input: ["text"], context_window: 200000, max_tokens: 8192 },
					{ id: "glm-5.3-flash", reasoning: false, input: ["text"], context_window: 200000, max_tokens: 8192 },
				],
			},
		},
	});

	async function boot(reasoning: boolean) {
		const root = mkdtempSync(join(tmpdir(), "neko-thinking-"));
		scratch.push(root);
		writeFileSync(join(root, "models.json"), JSON.stringify(modelsJson(reasoning)));
		const bridge = new TuiBridge({
			defaultDirectory: root,
			modelsPath: join(root, "models.json"),
			stateDir: join(root, "sessions"),
			state: new RuntimeState(join(root, "runtime", "state.sqlite")),
			onLog: () => {},
			createAgent: async () =>
				({
					async prompt() {},
					subscribe: () => () => {},
					async setModel() {},
					async abort() {},
					async waitForIdle() {},
					dispose() {},
				}) as BridgeAgent,
		});
		const port = await bridge.listen();
		const post = (pathSuffix: string, body?: unknown) =>
			fetch(`http://127.0.0.1:${port}${pathSuffix}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {}),
			});
		const get = (pathSuffix: string) => fetch(`http://127.0.0.1:${port}${pathSuffix}`);
		return { bridge, root, post, get };
	}

	test("modelless session inherits the default model's reasoning capability", async () => {
		const { bridge, root, post, get } = await boot(true);
		try {
			// Created WITHOUT a model — the session executes on the default.
			await post("/api/session", { id: "ses_t", location: { directory: root } });
			// GET reports the executing model with its capability so the picker
			// can gate upfront.
			const info = (await (await get("/api/session/ses_t/thinking")).json()) as {
				level: string;
				model?: { id: string; reasoning: boolean };
			};
			expect(info.level).toBe("off");
			expect(info.model?.id).toBe("glm-5.3");
			expect(info.model?.reasoning).toBe(true);
			const reasoning = await post("/api/session/ses_t/thinking", { level: "high" });
			expect(reasoning.status).toBe(204);
			// "off" stays accepted regardless of model.
			const off = await post("/api/session/ses_t/thinking", { level: "off" });
			expect(off.status).toBe(204);
		} finally {
			await bridge.close();
		}
	});

	test("session whose saved model vanished falls back to the default's capability", async () => {
		const { bridge, root, post } = await boot(true);
		try {
			// A model that is NOT in the catalog anymore (deleted config).
			await post("/api/session", {
				id: "ses_t",
				location: { directory: root },
				model: { providerID: "zai", id: "glm-deleted" },
			});
			const response = await post("/api/session/ses_t/thinking", { level: "medium" });
			expect(response.status).toBe(204);
		} finally {
			await bridge.close();
		}
	});

	test("genuinely unreasoning catalogs still refuse levels", async () => {
		const { bridge, root, post, get } = await boot(false);
		try {
			await post("/api/session", { id: "ses_t", location: { directory: root } });
			const info = (await (await get("/api/session/ses_t/thinking")).json()) as {
				model?: { reasoning: boolean };
			};
			expect(info.model?.reasoning).toBe(false);
			const response = await post("/api/session/ses_t/thinking", { level: "high" });
			expect(response.status).toBe(415);
		} finally {
			await bridge.close();
		}
	});
});
