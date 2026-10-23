import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { getRuntimeState } from "../../src/core/runtime/state-db.ts";
import { loadWardrobe } from "../../src/core/wardrobe.ts";
import memoryExtension from "../../src/extensions/memory/index.ts";
import runtimeContextExtension from "../../src/extensions/runtime-context/index.ts";
import { createHarness, getUserTexts } from "./harness.ts";

const factories = [
	{ name: "runtime-context", factory: runtimeContextExtension },
	{ name: "memory", factory: memoryExtension },
];

it("wardrobe tool: add, wear, and lock manage the shared wardrobe safely", async () => {
	const root = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(root.tempDir, "global"));
	const harness = await createHarness({ extensionFactories: factories });
	try {
		const state = getRuntimeState();
		// Model adds a new outfit the user described.
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("wardrobe", {
						action: "add",
						id: "jk",
						name: "JK制服",
						description: "白衬衫百褶裙，膝上袜",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("加好了哟"),
		]);
		await harness.session.prompt("主人给你买了套JK");
		const wardrobeFile = join(root.tempDir, "global", "persona", "wardrobe.json");
		expect(existsSync(wardrobeFile)).toBe(true);
		expect(loadWardrobe(join(root.tempDir, "global")).outfits.map((o) => o.id)).toContain("jk");

		// Wear it immediately.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wardrobe", { action: "wear", id: "jk" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("换上了"),
		]);
		await harness.session.prompt("现在就穿给我看");
		expect(state.getWardrobeState().current).toBe("jk");

		// Lock is the user's action; the model executes it.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wardrobe", { action: "lock", id: "jk" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("锁上了"),
		]);
		await harness.session.prompt("锁住这套，不许换");
		expect(loadWardrobe(join(root.tempDir, "global")).locked).toBe("jk");
		expect(state.getWardrobeState().current).toBe("jk");

		// Wearing something else while locked is refused with a reason.
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("wardrobe", { action: "add", id: "maid", name: "女仆装", description: "黑白围裙" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage([fauxToolCall("wardrobe", { action: "wear", id: "maid" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("被锁挡住了"),
		]);
		await harness.session.prompt("再试试穿女仆装");
		expect(state.getWardrobeState().current).toBe("jk");
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});

it("a broken wardrobe.json degrades to a prompt note instead of failing the message", async () => {
	const root = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(root.tempDir, "global"));
	const harness = await createHarness({ extensionFactories: factories });
	try {
		const personaDir = join(root.tempDir, "global", "persona");
		mkdirSync(personaDir, { recursive: true });
		writeFileSync(join(personaDir, "wardrobe.json"), '{"outfits": "broken"}');
		harness.setResponses([fauxAssistantMessage("还在")]);
		await harness.session.prompt("在吗");
		const prompt = getUserTexts(harness).at(-1)!;
		expect(prompt).toContain("<wardrobe_error>");
		// The message survives with an empty wardrobe: no crash, model informed.
		expect(prompt).toContain("在吗");
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});

it("a session restored before the wardrobe tool existed gets it re-activated", async () => {
	const root = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(root.tempDir, "global"));
	const harness = await createHarness({ extensionFactories: factories });
	try {
		// Simulate the old-session state: the transcript's tool loadout was
		// recorded before wardrobe existed, so the restored active set omits it.
		harness.session.setActiveToolsByName([
			"read",
			"bash",
			"edit",
			"write",
			"memory_write",
			"memory_recall",
			"continuity_update",
		]);
		expect(harness.session.getActiveToolNames()).not.toContain("wardrobe");
		// Any prompt passes session_start/before_agent_start: the extension
		// re-adds its system tool.
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");
		expect(harness.session.getActiveToolNames()).toContain("wardrobe");
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});
