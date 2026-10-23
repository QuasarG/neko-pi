import { randomInt } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { readState } from "./storage.ts";

export interface Outfit {
	id: string;
	name: string;
	description: string;
}

export interface Wardrobe {
	outfits: Outfit[];
	locked?: string;
}

export function loadWardrobe(root = getAgentDir()): Wardrobe {
	const value = readState(join(root, "persona", "wardrobe.json"));
	if (value === undefined) return { outfits: [] };
	if (!value || typeof value !== "object" || !("outfits" in value) || !Array.isArray(value.outfits))
		throw new Error("Invalid wardrobe configuration");
	const outfits: Outfit[] = [];
	for (const item of value.outfits) {
		if (!item || typeof item !== "object") throw new Error("Invalid wardrobe outfit");
		if ("enabled" in item && item.enabled === false) continue;
		if (
			!("id" in item) ||
			typeof item.id !== "string" ||
			!item.id ||
			item.id.length > 100 ||
			!("name" in item) ||
			typeof item.name !== "string" ||
			item.name.length > 100 ||
			!("description" in item) ||
			typeof item.description !== "string" ||
			Buffer.byteLength(item.description) > 2000 ||
			outfits.some((outfit) => outfit.id === item.id)
		)
			throw new Error("Invalid wardrobe outfit");
		outfits.push({ id: item.id, name: item.name, description: item.description });
	}
	const locked = "locked" in value ? value.locked : undefined;
	if (locked !== undefined && (typeof locked !== "string" || !outfits.some((outfit) => outfit.id === locked)))
		throw new Error("Locked outfit must name an enabled outfit");
	return { outfits, ...(typeof locked === "string" ? { locked } : {}) };
}

/**
 * Serialize a wardrobe for writing, validating with the same rules the
 * loader enforces — callers (the wardrobe tool) cannot produce a file the
 * loader would reject.
 */
export function buildWardrobeFile(outfits: Outfit[], locked?: string): string {
	const wardrobe: Wardrobe = locked ? { outfits, locked } : { outfits };
	// Reuse the loader's validation by round-tripping through JSON.
	const json = `${JSON.stringify(wardrobe, null, "\t")}\n`;
	const parsed = JSON.parse(json) as Wardrobe;
	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.outfits))
		throw new Error("Invalid wardrobe configuration");
	for (const item of parsed.outfits) {
		if (!item || typeof item !== "object") throw new Error("Invalid wardrobe outfit");
		if (
			!("id" in item) ||
			typeof item.id !== "string" ||
			!item.id ||
			item.id.length > 100 ||
			!("name" in item) ||
			typeof item.name !== "string" ||
			item.name.length > 100 ||
			!("description" in item) ||
			typeof item.description !== "string" ||
			Buffer.byteLength(item.description) > 2000 ||
			parsed.outfits.some((other) => other !== item && other.id === item.id)
		)
			throw new Error(`Invalid wardrobe outfit: ${item?.id ?? "(unnamed)"}`);
	}
	if (locked !== undefined && !parsed.outfits.some((outfit) => outfit.id === locked))
		throw new Error("Locked outfit must name an enabled outfit");
	return json;
}

export function chooseOutfit(wardrobe: Wardrobe, previous: Outfit | undefined, idle: boolean): Outfit | undefined {
	if (!wardrobe.outfits.length) return undefined;
	if (wardrobe.locked) return wardrobe.outfits.find((outfit) => outfit.id === wardrobe.locked);
	const current = wardrobe.outfits.find((outfit) => outfit.id === previous?.id);
	if (current && !idle) return current;
	const alternatives = wardrobe.outfits.filter((outfit) => outfit.id !== previous?.id);
	const candidates = alternatives.length ? alternatives : wardrobe.outfits;
	return candidates[randomInt(candidates.length)];
}
