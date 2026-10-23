import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import stylebankExtension from "../../src/extensions/stylebank/index.ts";
import { createHarness } from "./harness.ts";

/**
 * End-to-end stylebank: a configured rule fires when the model runs the
 * matching tool, delivering exactly one style hint as a steering message;
 * the cooldown suppresses a second firing on the following turns.
 */
it("stylebank fires once per cooldown window on matching tool results", async () => {
	const root = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(root.tempDir, "global"));
	// Rules are read from the live agent dir at tool_result time.
	mkdirSync(join(root.tempDir, "global", "persona"), { recursive: true });
	writeFileSync(
		join(root.tempDir, "global", "persona", "stylebank.json"),
		JSON.stringify({
			rules: [
				{
					id: "git-push-flair",
					tool: "bash",
					prefix: ["git", "push"],
					outcome: "any",
					hint: "庆祝 git push 成功：带一点得意的语气。",
					cooldownTurns: 3,
				},
			],
		}),
	);
	const harness = await createHarness({
		extensionFactories: [{ name: "stylebank", factory: stylebankExtension }],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "git push origin main" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("推上去了"),
		]);
		await harness.session.prompt("推一下");
		const hints = harness.session.messages.filter(
			(message) =>
				(message as { role?: string; customType?: string }).role === "custom" &&
				(message as { customType?: string }).customType === "stylebank",
		);
		expect(hints).toHaveLength(1);
		expect((hints[0] as { content: string }).content).toContain("庆祝 git push");
		const order = harness.session.messages.map((m) => (m as { role?: string }).role);
		expect(order.indexOf("custom")).toBeGreaterThan(order.indexOf("toolResult"));
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});
