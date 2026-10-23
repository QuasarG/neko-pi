import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import memoryExtension from "../../src/extensions/memory/index.ts";
import { createHarness, getMessageText, getToolResult } from "./harness.ts";

const factories = [{ name: "memory", factory: memoryExtension }];

it("continuity_update rejects over-budget summaries instead of truncating", async () => {
	const root = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(root.tempDir, "global"));
	const harness = await createHarness({ extensionFactories: factories });
	try {
		// ~450 UTF-8 bytes of Chinese — over the 300-byte continuity budget.
		const oversized = "很".repeat(150);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("continuity_update", { summary: oversized })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("continuity_update", { summary: "我们在做 X，主人刚夸过 Neko" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("好了"),
		]);
		await harness.session.prompt("记一下当前状态");
		// getToolResult returns the LATEST call: the within-budget follow-up
		// must have saved cleanly…
		const last = getToolResult(harness, "continuity_update");
		expect(getMessageText(last)).toContain("Continuity updated.");
		// …while the transcript's earlier tool result carries the honest
		// refusal with the budget named, not a truncated save.
		const all = harness.session.messages
			.filter((message) => message.role === "toolResult" && message.toolName === "continuity_update")
			.map((message) => getMessageText(message))
			.join("\n");
		expect(all).toContain("Not saved: summary is");
		expect(all).toContain("300-byte continuity budget");
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});
