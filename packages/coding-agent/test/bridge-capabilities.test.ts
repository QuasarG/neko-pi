import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type ModelRuntimeLike, TuiBridge } from "../src/modes/tui-bridge/server.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeRuntime(
	models: Array<{ id: string; provider?: string; input?: string[]; reasoning?: boolean }>,
): ModelRuntimeLike {
	return {
		getAllModels: () =>
			models.map((model) => ({
				id: model.id,
				name: model.id,
				provider: model.provider ?? "demo",
				contextWindow: 128000,
				maxTokens: 4096,
				input: model.input ?? ["text"],
				reasoning: model.reasoning ?? false,
			})),
		getAvailableSnapshot: () => [],
		hasConfiguredAuth: () => true,
	};
}

function boot(runtime?: ModelRuntimeLike) {
	const root = mkdtempSync(join(tmpdir(), "neko-cap-"));
	scratch.push(root);
	return new TuiBridge({
		defaultDirectory: root,
		modelsPath: "/nonexistent.json",
		stateDir: join(root, "sessions"),
		modelRuntime: runtime,
		onLog: () => {},
		createAgent: async () => ({
			async prompt() {},
			subscribe: () => () => {},
			async setModel() {},
			async abort() {},
			async waitForIdle() {},
			dispose() {},
		}),
	});
}

describe("capabilities and real catalog (A03–A05)", () => {
	test("K02: unknown GET paths fail explicitly instead of returning an empty list", async () => {
		const bridge = boot();
		const port = await bridge.listen();
		try {
			const unknown = await fetch(`http://127.0.0.1:${port}/api/definitely-not-real`);
			expect(unknown.status).toBe(404);
			const body = (await unknown.json()) as { error: string };
			expect(body.error).toBe("not-implemented");
			// A legitimately-empty list is still a valid empty list.
			const sessions = await fetch(`http://127.0.0.1:${port}/api/session`);
			expect(sessions.status).toBe(200);
			expect(((await sessions.json()) as { data: unknown[] }).data).toEqual([]);
		} finally {
			await bridge.close();
		}
	});

	test("K01: capabilities carry protocol version and honest image/thinking state", async () => {
		const bridge = boot(fakeRuntime([{ id: "text-only" }]));
		const port = await bridge.listen();
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/neko/capabilities`);
			expect(response.status).toBe(200);
			const capabilities = (await response.json()) as {
				protocol: number;
				global: Record<string, { status: string; limitations?: string[] }>;
				perModel: Record<string, { limitations: string[] }>;
			};
			expect(capabilities.protocol).toBe(1);
			expect(capabilities.global.imageAttachments?.status).toBe("unavailable");
			expect(capabilities.perModel["text-only"]?.limitations).toContain("image input rejected by this model");
		} finally {
			await bridge.close();
		}
	});

	test("M01: catalog mirrors the runtime registry with real metadata", async () => {
		const bridge = boot(
			fakeRuntime([
				{ id: "vision-model", input: ["text", "image"] },
				{ id: "reasoner", reasoning: true },
			]),
		);
		const port = await bridge.listen();
		try {
			const models = (await (await fetch(`http://127.0.0.1:${port}/api/model`)).json()) as {
				data: Array<{ id: string; limit: { context: number }; capabilities: { input: string[] } }>;
			};
			expect(models.data.map((m) => m.id).sort()).toEqual(["reasoner", "vision-model"]);
			expect(models.data[0]!.limit.context).toBe(128000);
			const vision = models.data.find((m) => m.id === "vision-model")!;
			expect(vision.capabilities.input).toContain("image");
		} finally {
			await bridge.close();
		}
	});

	test("M02: default model is the first authorized one, never a name guess", async () => {
		const bridge = boot(fakeRuntime([{ id: "not-flashy" }, { id: "flashy-flash" }, { id: "another" }]));
		const port = await bridge.listen();
		try {
			const fallback = (await (await fetch(`http://127.0.0.1:${port}/api/model/default`)).json()) as {
				data: { id: string };
			};
			// Registry order wins; no substring matching on "flash".
			expect(fallback.data.id).toBe("not-flashy");
		} finally {
			await bridge.close();
		}
	});

	test("A10: vcs reports the real branch and stays absent outside a repo", async () => {
		const repo = mkdtempSync(join(tmpdir(), "neko-vcs-"));
		scratch.push(repo);
		execSync("git init -q -b feature/x .", { cwd: repo });
		const bridge = new TuiBridge({
			defaultDirectory: repo,
			modelsPath: "/nonexistent.json",
			onLog: () => {},
			createAgent: async () => ({
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
			const url = `http://127.0.0.1:${port}/api/vcs?location%5Bdirectory%5D=${encodeURIComponent(repo)}`;
			const inRepo = (await (await fetch(url)).json()) as { data: { branch: { current?: string } } };
			expect(inRepo.data.branch.current).toBe("feature/x");
			const outsideUrl = `http://127.0.0.1:${port}/api/vcs?location%5Bdirectory%5D=${encodeURIComponent(join(repo, "nowhere"))}`;
			const outside = (await (await fetch(outsideUrl)).json()) as { data: { branch: { current?: string } } };
			expect(outside.data.branch.current).toBeUndefined();
		} finally {
			await bridge.close();
		}
	});
});
