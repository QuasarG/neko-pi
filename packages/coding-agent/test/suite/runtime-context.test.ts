import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import runtimeContextExtension from "../../src/extensions/runtime-context/index.ts";
import { createHarness, getUserTexts } from "./harness.ts";

it("persists each message time across midnight without rewriting history or the system prompt", async () => {
	vi.stubEnv("TZ", "Asia/Shanghai");
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-20T15:59:59.000Z"));
	const harness = await createHarness({
		extensionFactories: [
			{ name: "runtime-context", factory: runtimeContextExtension },
			{
				name: "later-hook",
				factory: (pi) => {
					pi.on("before_agent_start", () => {});
				},
			},
		],
	});
	const prompts: string[] = [];
	harness.setResponses(
		[0, 1].map(() => (context) => {
			prompts.push(getCurrentSystemPrompt(context.messages));
			return fauxAssistantMessage("OK");
		}),
	);
	try {
		await harness.session.prompt("hello");
		const firstMessage = structuredClone(harness.session.messages.find((message) => message.role === "user"));
		vi.setSystemTime(new Date("2026-10-20T16:00:01.000Z"));
		await harness.session.prompt("what about tomorrow?");
		expect(harness.session.messages.find((message) => message.role === "user")).toEqual(firstMessage);
		expect(prompts[1]).toBe(prompts[0]);
		expect(
			prompts.every(
				(prompt) => !prompt.includes("2026-10-20T15:59:59.000Z") && !prompt.includes("2026-10-20T16:00:01.000Z"),
			),
		).toBe(true);
		expect(getUserTexts(harness)).toEqual([
			"hello\n\n<message_time>2026-10-20T15:59:59.000Z (Tuesday, 20/10/2026, 23:59:59, Asia/Shanghai)</message_time>",
			"what about tomorrow?\n\n<message_time>2026-10-20T16:00:01.000Z (Wednesday, 21/10/2026, 00:00:01, Asia/Shanghai)</message_time>",
		]);
	} finally {
		harness.cleanup();
		vi.useRealTimers();
		vi.unstubAllEnvs();
	}
});

it("refreshes one installed global identity in an already-open session", async () => {
	const root = await createHarness();
	const global = join(root.tempDir, "global");
	vi.stubEnv("NEKO_PI_HOME", global);
	mkdirSync(join(global, "persona"), { recursive: true });
	writeFileSync(join(global, "persona", "persona.md"), "First global identity");
	const harness = await createHarness({
		extensionFactories: [{ name: "runtime-context", factory: runtimeContextExtension }],
	});
	const prompts: string[] = [];
	harness.setResponses(
		[0, 1].map(() => (context) => {
			prompts.push(getCurrentSystemPrompt(context.messages));
			return fauxAssistantMessage("OK");
		}),
	);
	try {
		await harness.session.prompt("first");
		writeFileSync(join(global, "persona", "persona.md"), "Updated global identity");
		await harness.session.prompt("second");
		expect(prompts[0]).toContain("First global identity");
		expect(prompts[1]).toContain("Updated global identity");
		expect(prompts[1]).not.toContain("First global identity");
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});
