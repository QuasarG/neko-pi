import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { getRuntimeState } from "../../src/core/runtime/state-db.ts";
import { loadWardrobe } from "../../src/core/wardrobe.ts";
import memoryExtension from "../../src/extensions/memory/index.ts";
import runtimeContextExtension from "../../src/extensions/runtime-context/index.ts";
import { createHarness, getMessageText, getToolResult, getUserTexts } from "./harness.ts";

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
		// Every other registered tool stays listed, so wardrobe is the one
		// frozen system tool this repair round rescues.
		harness.session.setActiveToolsByName([
			"read",
			"bash",
			"edit",
			"write",
			"memory_write",
			"memory_promote",
			"memory_recall",
			"continuity_update",
		]);
		expect(harness.session.getActiveToolNames()).not.toContain("wardrobe");
		// Any prompt passes session_start/before_agent_start: the extension
		// re-adds its system tool.
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");
		expect(harness.session.getActiveToolNames()).toContain("wardrobe");
		// The repair is visible: a toolset-update custom message lands in the
		// transcript so the context audit shows what changed (deepseek-harness
		// toolsUpdated row).
		const markers = harness.session.messages.filter(
			(message) =>
				(message as { role?: string; customType?: string }).role === "custom" &&
				(message as { customType?: string }).customType === "toolset-update",
		);
		expect(markers).toHaveLength(1);
		expect((markers[0] as { content: string }).content).toContain("+wardrobe");
		// And it does not repeat once the set already carries the tool.
		harness.setResponses([fauxAssistantMessage("again")]);
		await harness.session.prompt("second");
		const again = harness.session.messages.filter(
			(message) =>
				(message as { role?: string; customType?: string }).role === "custom" &&
				(message as { customType?: string }).customType === "toolset-update",
		);
		expect(again).toHaveLength(1);
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});

it("wardrobe tool: add_part persists normalized slots and list groups parts by slot", async () => {
	const root = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(root.tempDir, "global"));
	const harness = await createHarness({ extensionFactories: factories });
	const home = join(root.tempDir, "global");
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("wardrobe", {
						action: "add_part",
						id: "white-lace-sock",
						slot: "Feet",
						name: "蕾丝白袜",
						description: "袜口一圈细蕾丝",
					}),
					fauxToolCall("wardrobe", {
						action: "add_part",
						id: "none-torso",
						slot: "torso",
						name: "无上装",
						description: "什么都没穿",
					}),
					fauxToolCall("wardrobe", { action: "list" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("登记好了"),
		]);
		await harness.session.prompt("把这两件登记进衣柜");
		// Slots are normalized on the way in; the catalog persists.
		expect(loadWardrobe(home).parts?.map((part) => [part.id, part.slot])).toEqual([
			["white-lace-sock", "feet"],
			["none-torso", "torso"],
		]);
		// list reports parts grouped under their slot.
		const listText = getMessageText(getToolResult(harness, "wardrobe"));
		expect(listText).toContain("feet: white-lace-sock (蕾丝白袜)");
		expect(listText).toContain("torso: none-torso (无上装)");
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});

it("wardrobe tool: remove_part refuses while referenced and succeeds after the outfit is gone", async () => {
	const root = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(root.tempDir, "global"));
	const harness = await createHarness({ extensionFactories: factories });
	const home = join(root.tempDir, "global");
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("wardrobe", {
						action: "add_part",
						id: "white-lace-sock",
						slot: "feet",
						name: "蕾丝白袜",
						description: "袜口一圈细蕾丝",
					}),
					// Preset outfit built from parts, no description: synthesized.
					fauxToolCall("wardrobe", {
						action: "add",
						id: "preset",
						name: "白袜预设",
						parts: { feet: "white-lace-sock" },
					}),
					fauxToolCall("wardrobe", { action: "remove_part", id: "white-lace-sock" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("被挡住了"),
		]);
		await harness.session.prompt("存个白袜预设，然后试着删袜子");
		const guard = getMessageText(getToolResult(harness, "wardrobe"));
		expect(guard).toContain("used by preset");
		const after = loadWardrobe(home);
		expect(after.parts?.map((part) => part.id)).toContain("white-lace-sock");
		// add with parts and no description persisted a preset with the
		// synthesized description.
		expect(after.outfits.find((outfit) => outfit.id === "preset")?.description).toBe(
			"feet — 蕾丝白袜：袜口一圈细蕾丝",
		);
		// Once the referencing outfit is removed, the part goes too.
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("wardrobe", { action: "remove", id: "preset" }),
					fauxToolCall("wardrobe", { action: "remove_part", id: "white-lace-sock" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("删掉了"),
		]);
		await harness.session.prompt("预设不要了，袜子也删掉");
		const removed = getMessageText(getToolResult(harness, "wardrobe"));
		expect(removed).toContain("removed part white-lace-sock");
		expect(loadWardrobe(home).parts ?? []).toHaveLength(0);
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});

it("wardrobe tool: wear parts creates a deterministic generated outfit and reuses it", async () => {
	const root = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(root.tempDir, "global"));
	const harness = await createHarness({ extensionFactories: factories });
	const home = join(root.tempDir, "global");
	try {
		const state = getRuntimeState();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("wardrobe", {
						action: "add_part",
						id: "white-lace-sock",
						slot: "feet",
						name: "蕾丝白袜",
						description: "袜口一圈细蕾丝",
					}),
					fauxToolCall("wardrobe", {
						action: "add_part",
						id: "none-torso",
						slot: "torso",
						name: "无上装",
						description: "什么都没穿",
					}),
					fauxToolCall("wardrobe", { action: "wear", parts: { feet: "white-lace-sock", torso: "none-torso" } }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("穿上了"),
		]);
		await harness.session.prompt("穿上白袜，上身不穿");
		const first = state.getWardrobeState().current;
		expect(first).toMatch(/^combo-[0-9a-f]{10}$/);
		const combo = loadWardrobe(home).outfits.find((outfit) => outfit.id === first);
		expect(combo?.generated).toBe(true);
		expect(combo?.parts).toEqual({ feet: "white-lace-sock", torso: "none-torso" });
		expect(combo?.description).toBe("feet — 蕾丝白袜：袜口一圈细蕾丝\ntorso — 无上装：什么都没穿");

		// The same mapping in a different key order reuses the same outfit.
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("wardrobe", { action: "wear", parts: { torso: "none-torso", feet: "white-lace-sock" } })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("还是这套"),
		]);
		await harness.session.prompt("再穿一次刚才那套");
		expect(state.getWardrobeState().current).toBe(first);
		const reloaded = loadWardrobe(home);
		expect(reloaded.outfits.filter((outfit) => outfit.generated)).toHaveLength(1);
		expect(getMessageText(getToolResult(harness, "wardrobe"))).toContain(`now wearing ${first}`);
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});

it("wardrobe tool: wear demands exactly one of id or parts and resolves references", async () => {
	const root = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(root.tempDir, "global"));
	const harness = await createHarness({ extensionFactories: factories });
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("wardrobe", { action: "wear", id: "a", parts: { feet: "white-lace-sock" } }),
					fauxToolCall("wardrobe", { action: "wear" }),
					fauxToolCall("wardrobe", { action: "wear", parts: { feet: "ghost-part" } }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("都失败了"),
		]);
		await harness.session.prompt("乱穿一通");
		const texts = harness.session.messages
			.filter(
				(message) =>
					(message as { role?: string }).role === "toolResult" &&
					(message as { toolName?: string }).toolName === "wardrobe",
			)
			.map((message) => getMessageText(message));
		expect(texts[0]).toContain("exactly one of id or parts");
		expect(texts[1]).toContain("exactly one of id or parts");
		expect(texts[2]).toContain("unknown part ghost-part");
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});
