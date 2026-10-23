import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { type BridgeAgent, TuiBridge } from "../src/modes/tui-bridge/server.ts";

test("attachment context is bounded, hidden from authored text, and frozen across failed delivery retries", async () => {
	const root = mkdtempSync(join(tmpdir(), "neko-attachments-"));
	const prompts: Array<{ text: string; images: unknown }> = [];
	writeFileSync(
		join(root, "models.json"),
		JSON.stringify({
			providers: { demo: { models: [{ id: "vision", input: ["text", "image"] }] } },
		}),
	);
	const bridge = new TuiBridge({
		defaultDirectory: root,
		modelsPath: join(root, "models.json"),
		onLog: () => {},
		createAgent: async (): Promise<BridgeAgent> => ({
			prompt: async (text, options) => {
				prompts.push({ text, images: options?.images });
				if (prompts.length === 1) throw new Error("provider unavailable");
			},
			subscribe: () => () => {},
			abort: async () => {},
			waitForIdle: async () => {},
			dispose: () => {},
			setModel: async () => {},
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
		await post("", { id: "ses_files", model: { providerID: "demo", id: "vision" } });
		const accepted = await post("/ses_files/prompt", {
			id: "msg_files",
			text: "inspect attachments",
			files: [
				{ name: "notes.txt", uri: `data:text/plain;base64,${Buffer.from("x".repeat(5000)).toString("base64")}` },
				{ name: "image.png", uri: "data:image/png;base64,aGVsbG8=" },
			],
		});
		expect(accepted.status).toBe(200);
		await vi.waitFor(async () => expect(await (await fetch(`${base}/active`)).json()).toEqual({ data: {} }));
		expect(prompts[0]?.text).toContain("x".repeat(4096));
		expect(prompts[0]?.text).not.toContain("x".repeat(4097));
		expect(prompts[0]?.text).toContain("(truncated)");
		const history = (await (await fetch(`${base}/ses_files/message`)).json()) as {
			data: Array<{ type: string; text: string; files?: Array<{ name: string; source: { uri: string } }> }>;
		};
		expect(history.data.find((item) => item.type === "user")?.text).toBe("inspect attachments");
		expect(history.data.find((item) => item.type === "user")?.files?.map((file) => file.name)).toEqual([
			"notes.txt",
			"image.png",
		]);
		// Retries cannot replace the accepted text or attachment payload.
		expect((await post("/ses_files/prompt", { id: "msg_files", text: "changed text" })).status).toBe(200);
		await vi.waitFor(() => expect(prompts).toHaveLength(2));
		expect(prompts[1]).toEqual(prompts[0]);
		expect(prompts[1]?.images).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
		expect((await post("/ses_files/prompt", { text: "bad", files: {} })).status).toBe(400);
	} finally {
		await bridge.close();
		rmSync(root, { recursive: true, force: true });
	}
});
