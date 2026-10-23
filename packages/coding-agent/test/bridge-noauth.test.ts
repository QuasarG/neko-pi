import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RuntimeState } from "../src/core/runtime/state-db.ts";
import { type BridgeAgent, type ModelRuntimeLike, TuiBridge } from "../src/modes/tui-bridge/server.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A05: with no configured credentials the catalog must tell the truth —
 * every model unauthorized, the default-model resolution refusing with 409
 * instead of falling back to a model the user cannot run.
 */
describe("no-credentials catalog behaviour", () => {
	const runtime: ModelRuntimeLike = {
		getAllModels: () => [
			{
				id: "glm-5.3",
				name: "GLM-5.3",
				provider: "zai",
				contextWindow: 200000,
				maxTokens: 8192,
				input: ["text"],
				reasoning: true,
			},
		],
		getAvailableSnapshot: () => [],
		hasConfiguredAuth: () => false,
	};

	test("catalog marks unauthorized and default resolution returns 409", async () => {
		const root = mkdtempSync(join(tmpdir(), "neko-noauth-"));
		scratch.push(root);
		const bridge = new TuiBridge({
			defaultDirectory: root,
			stateDir: join(root, "sessions"),
			state: new RuntimeState(join(root, "runtime", "state.sqlite")),
			modelRuntime: runtime,
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
		const base = `http://127.0.0.1:${port}`;
		try {
			const catalog = (await (await fetch(`${base}/api/model`)).json()) as {
				data: Array<{ id: string; status: string }>;
			};
			expect(catalog.data).toHaveLength(1);
			expect(catalog.data[0]!.status).toBe("unauthorized");
			const fallback = await fetch(`${base}/api/model/default`);
			expect(fallback.status).toBe(409);
			const body = (await fallback.json()) as { message: string };
			expect(body.message).toContain("No model available");
		} finally {
			await bridge.close();
		}
	});
});
