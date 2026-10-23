import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type BridgeAgent, TuiBridge } from "../src/modes/tui-bridge/server.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RecordedPrompt {
	text: string;
	options?: { images?: Array<{ data: string; mimeType: string }>; streamingBehavior?: string };
}

async function boot(options?: { imageModel?: boolean }) {
	const root = mkdtempSync(join(tmpdir(), "neko-input-"));
	scratch.push(root);
	const prompts: RecordedPrompt[] = [];
	const gates: Array<() => void> = [];
	const models = options?.imageModel
		? [{ id: "vision", providerID: "demo", name: "vision", capabilities: { input: ["text", "image"] } }]
		: [{ id: "text-only", providerID: "demo", name: "text-only", capabilities: { input: ["text"] } }];
	writeFileSync(
		join(root, "models.json"),
		JSON.stringify({
			providers: {
				demo: {
					models: models.map((m) => ({
						id: m.id,
						name: m.name,
						context_window: 100000,
						input: m.capabilities.input,
					})),
				},
			},
		}),
	);
	const bridge = new TuiBridge({
		defaultDirectory: root,
		modelsPath: join(root, "models.json"),
		stateDir: join(root, "sessions"),
		onLog: () => {},
		// The runtime-less path can't supply capabilities; instead pin the
		// catalog by writing the same models.json the bridge loads.
		createAgent: async () => {
			const agent: BridgeAgent = {
				async prompt(text, opts) {
					prompts.push({
						text,
						options: (opts as RecordedPrompt["options"]) ?? undefined,
					});
					if (gates.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
					else await new Promise<void>((resolve) => gates.push(resolve));
				},
				subscribe: () => () => {},
				async setModel() {},
				async abort() {
					for (const resolve of gates.splice(0)) resolve();
				},
				async waitForIdle() {},
				dispose() {},
			};
			return agent;
		},
	});
	const port = await bridge.listen();
	return { bridge, port, root, prompts, gates };
}

describe("input acceptance matrix (A07/A08)", () => {
	test("images reach the native prompt for image-capable models", async () => {
		const { bridge, port, prompts } = await boot({ imageModel: true });
		try {
			await fetch(`http://127.0.0.1:${port}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "ses_img", model: { providerID: "demo", id: "vision" }, location: {} }),
			});
			const response = await fetch(`http://127.0.0.1:${port}/api/session/ses_img/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					text: "look at this",
					files: [{ uri: "data:image/png;base64,aGVsbG8=" }],
				}),
			});
			expect(response.status).toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(prompts).toHaveLength(1);
			expect(prompts[0]!.options?.images).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
		} finally {
			await bridge.close();
		}
	});

	test("text-only model rejects image input with a specific error (I02)", async () => {
		const { bridge, port, prompts } = await boot();
		try {
			await fetch(`http://127.0.0.1:${port}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "ses_txt", location: {} }),
			});
			const response = await fetch(`http://127.0.0.1:${port}/api/session/ses_txt/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					text: "look",
					files: [{ uri: "data:image/png;base64,aGVsbG8=" }],
				}),
			});
			expect(response.status).toBe(415);
			const body = (await response.json()) as { message: string };
			expect(body.message).toContain("image");
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(prompts).toHaveLength(0);
		} finally {
			await bridge.close();
		}
	});

	test("unsupported fields are rejected, never silently dropped", async () => {
		const { bridge, port } = await boot();
		try {
			await fetch(`http://127.0.0.1:${port}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "ses_rej", location: {} }),
			});
			for (const field of ["agents", "skills", "variant"]) {
				const response = await fetch(`http://127.0.0.1:${port}/api/session/ses_rej/prompt`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text: "hi", [field]: [{}] }),
				});
				expect(response.status).toBe(400);
				const body = (await response.json()) as { message: string };
				expect(body.message).toContain(field);
			}
			const fileUri = await fetch(`http://127.0.0.1:${port}/api/session/ses_rej/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "hi", files: [{ uri: "file:///etc/passwd" }] }),
			});
			expect(fileUri.status).toBe(400);
			// Non-image data URIs (like PDF) are accepted as text file context (A08).
			const wrongMime = await fetch(`http://127.0.0.1:${port}/api/session/ses_rej/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "hi", files: [{ uri: "data:application/pdf;base64,aGVsbG8=" }] }),
			});
			expect(wrongMime.status).toBe(200);
			const missingUri = await fetch(`http://127.0.0.1:${port}/api/session/ses_rej/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "hi", files: [{ name: "no-uri-here" }] }),
			});
			expect(missingUri.status).toBe(400);
		} finally {
			await bridge.close();
		}
	});

	test("steer during a live run enters the native steering path (Q01)", async () => {
		const { bridge, port, prompts, gates } = await boot();
		try {
			await fetch(`http://127.0.0.1:${port}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "ses_steer", location: {} }),
			});
			// First message blocks on the gate (a live run).
			gates.push(() => undefined);
			await fetch(`http://127.0.0.1:${port}/api/session/ses_steer/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "msg_first", text: "long running task", delivery: "steer" }),
			});
			await new Promise((resolve) => setTimeout(resolve, 50));
			// A steer while running goes straight to the backend, not the queue.
			await fetch(`http://127.0.0.1:${port}/api/session/ses_steer/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "msg_steer", text: "actually do X first", delivery: "steer" }),
			});
			await new Promise((resolve) => setTimeout(resolve, 150));
			// The steer text carries the injected frozen context block.
			const steerCall = prompts.find((prompt) => prompt.text.startsWith("actually do X first"));
			expect(steerCall).toBeDefined();
			expect(steerCall!.options?.streamingBehavior).toBe("steer");
			expect(steerCall!.text).toContain("<message_time>");
			// The queue holds zero pending steers: it was consumed live.
			const inbox = (await (await fetch(`http://127.0.0.1:${port}/api/session/ses_steer/inbox`)).json()) as {
				data: unknown[];
			};
			expect(inbox.data).toHaveLength(0);
			for (const release of gates.splice(0)) release();
			await new Promise((resolve) => setTimeout(resolve, 150));
		} finally {
			for (const release of gates.splice(0)) release();
			await bridge.close();
		}
	});

	test("queue mode accepts steer/followUp and rejects unknown modes (Q02)", async () => {
		const { bridge, port } = await boot();
		try {
			await fetch(`http://127.0.0.1:${port}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "ses_q", location: {} }),
			});
			const good = await fetch(`http://127.0.0.1:${port}/api/session/ses_q/queue/mode`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "followUp" }),
			});
			expect(good.status).toBe(204);
			const bad = await fetch(`http://127.0.0.1:${port}/api/session/ses_q/queue/mode`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "whenever" }),
			});
			expect(bad.status).toBe(400);
		} finally {
			await bridge.close();
		}
	});

	test("thinking level accepts pi levels; rejects on unreasoning models (M04)", async () => {
		const { bridge, port } = await boot();
		try {
			await fetch(`http://127.0.0.1:${port}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "ses_think", location: {} }),
			});
			const badLevel = await fetch(`http://127.0.0.1:${port}/api/session/ses_think/thinking`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ level: "ultra" }),
			});
			expect(badLevel.status).toBe(400);
			const unreasoning = await fetch(`http://127.0.0.1:${port}/api/session/ses_think/thinking`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ level: "high" }),
			});
			expect(unreasoning.status).toBe(415);
			const off = await fetch(`http://127.0.0.1:${port}/api/session/ses_think/thinking`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ level: "off" }),
			});
			expect(off.status).toBe(204);
		} finally {
			await bridge.close();
		}
	});

	test("unknown model switch is rejected instead of accepted silently (M04)", async () => {
		const { bridge, port } = await boot();
		try {
			await fetch(`http://127.0.0.1:${port}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "ses_m", location: {} }),
			});
			const response = await fetch(`http://127.0.0.1:${port}/api/session/ses_m/model`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: { providerID: "demo", id: "ghost-model" } }),
			});
			expect(response.status).toBe(400);
		} finally {
			await bridge.close();
		}
	});
});
