import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	buildWardrobeFile,
	combinationId,
	loadWardrobe,
	normalizeWardrobeSlot,
	partDescription,
	type Wardrobe,
	type WardrobePart,
} from "../src/core/wardrobe.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const setup = (json: string): string => {
	const root = mkdtempSync(join(tmpdir(), "neko-wardrobe-"));
	scratch.push(root);
	mkdirSync(join(root, "persona"), { recursive: true });
	writeFileSync(join(root, "persona", "wardrobe.json"), json);
	return root;
};

const catalog: WardrobePart[] = [
	{ id: "white-lace-sock", slot: "feet", name: "蕾丝白袜", description: "袜口一圈细蕾丝" },
	{ id: "none-torso", slot: "torso", name: "无上装", description: "什么都没穿" },
];

describe("wardrobe model", () => {
	test("legacy wardrobe files load unchanged", () => {
		const legacy = JSON.stringify({
			outfits: [{ id: "seal-night-001", name: "封印之夜·裸 Neko", description: "黑长直散发、猫咪发夹" }],
		});
		const wardrobe = loadWardrobe(setup(legacy));
		expect(wardrobe).toEqual({
			outfits: [{ id: "seal-night-001", name: "封印之夜·裸 Neko", description: "黑长直散发、猫咪发夹" }],
		});
		expect(wardrobe.parts).toBeUndefined();
	});

	test("part outfits synthesize stable descriptions and reject dangling references", () => {
		const file = {
			parts: catalog,
			outfits: [
				{
					id: "combo-1",
					name: "白袜组合",
					parts: { feet: "white-lace-sock", torso: "none-torso" },
					generated: true,
				},
			],
		};
		const wardrobe = loadWardrobe(setup(JSON.stringify(file)));
		expect(wardrobe.outfits[0].description).toBe("feet — 蕾丝白袜：袜口一圈细蕾丝\ntorso — 无上装：什么都没穿");
		expect(wardrobe.outfits[0].generated).toBe(true);
		expect(wardrobe.outfits[0].parts).toEqual({ feet: "white-lace-sock", torso: "none-torso" });
		// An explicit description is an override, never replaced by synthesis.
		const overridden = loadWardrobe(
			setup(
				JSON.stringify({
					parts: catalog,
					outfits: [{ id: "preset", name: "预设", description: "手写描述", parts: { feet: "white-lace-sock" } }],
				}),
			),
		);
		expect(overridden.outfits[0].description).toBe("手写描述");
		// Dangling reference.
		const dangling = { parts: catalog, outfits: [{ id: "x", name: "x", parts: { feet: "ghost" } }] };
		expect(() => loadWardrobe(setup(JSON.stringify(dangling)))).toThrow(/unknown part/);
		// Non-normalized slot key in an outfit mapping is rejected.
		const sloppy = {
			parts: catalog,
			outfits: [{ id: "x", name: "x", parts: { Feet: "white-lace-sock" } }],
		};
		expect(() => loadWardrobe(setup(JSON.stringify(sloppy)))).toThrow(/Invalid wardrobe outfit/);
		// Description may only be omitted with a non-empty parts mapping.
		const bare = { parts: catalog, outfits: [{ id: "x", name: "x" }] };
		expect(() => loadWardrobe(setup(JSON.stringify(bare)))).toThrow(/Invalid wardrobe outfit/);
	});

	test("partDescription is stable across call order and respects the description byte budget", () => {
		const outfit = { id: "c", name: "c", description: "", parts: { torso: "none-torso", feet: "white-lace-sock" } };
		const first = partDescription(outfit, [...catalog].reverse());
		expect(first).toBe(partDescription(outfit, catalog));
		expect(first.split("\n")[0]).toBe("feet — 蕾丝白袜：袜口一圈细蕾丝");
		// Long part descriptions synthesize a description the loader accepts.
		const long: WardrobePart[] = [
			{ id: "a", slot: "a", name: "a", description: "长".repeat(1200) },
			{ id: "b", slot: "b", name: "b", description: "长".repeat(1200) },
		];
		const synthesized = partDescription({ id: "x", name: "x", description: "", parts: { a: "a", b: "b" } }, long);
		expect(Buffer.byteLength(synthesized)).toBeLessThanOrEqual(2000);
	});

	test("combination ids are canonical and slot-order independent", () => {
		expect(combinationId({ feet: "white-lace-sock", torso: "none-torso" })).toBe(
			combinationId({ torso: "none-torso", feet: "white-lace-sock" }),
		);
		expect(combinationId({ feet: "white-lace-sock" })).toMatch(/^combo-[0-9a-f]{10}$/);
		expect(combinationId({ feet: "white-lace-sock" })).not.toBe(combinationId({ feet: "other-sock" }));
		expect(combinationId({ feet: "a" })).not.toBe(combinationId({ feet: "a", torso: "b" }));
	});

	test("normalizeWardrobeSlot slugs and rejects empty or oversized results", () => {
		expect(normalizeWardrobeSlot("Feet")).toBe("feet");
		expect(normalizeWardrobeSlot("  Lower  Arm!")).toBe("lower-arm");
		expect(normalizeWardrobeSlot("x".repeat(32))).toBe("x".repeat(32));
		expect(() => normalizeWardrobeSlot("!!!")).toThrow();
		expect(() => normalizeWardrobeSlot("")).toThrow();
		expect(() => normalizeWardrobeSlot("x".repeat(33))).toThrow();
	});

	test("buildWardrobeFile round-trips a part wardrobe and rejects invalid ones", () => {
		const wardrobe: Wardrobe = {
			parts: catalog,
			outfits: [
				{
					id: "combo-1",
					name: "白袜组合",
					description: partDescription(
						{ id: "combo-1", name: "白袜组合", description: "", parts: { feet: "white-lace-sock" } },
						catalog,
					),
					parts: { feet: "white-lace-sock" },
					generated: true,
				},
			],
		};
		const json = buildWardrobeFile(wardrobe);
		expect(loadWardrobe(setup(json))).toEqual(wardrobe);
		// Legacy-shaped wardrobes keep the legacy file shape.
		const legacyJson = buildWardrobeFile({ outfits: [{ id: "a", name: "b", description: "c" }], locked: "a" });
		expect(legacyJson).not.toContain('"parts"');
		expect(loadWardrobe(setup(legacyJson))).toEqual({
			outfits: [{ id: "a", name: "b", description: "c" }],
			locked: "a",
		});
		// A dangling reference cannot be persisted.
		expect(() =>
			buildWardrobeFile({
				outfits: [{ id: "x", name: "x", description: "d", parts: { feet: "ghost" } }],
			}),
		).toThrow(/unknown part/);
	});
});
