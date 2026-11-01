import { createHash, randomInt } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { readState } from "./storage.ts";

export interface WardrobePart {
	id: string;
	slot: string;
	name: string;
	description: string;
}

export interface Outfit {
	id: string;
	name: string;
	description: string;
	parts?: Record<string, string>; // slot -> part id
	generated?: boolean;
}

export interface Wardrobe {
	outfits: Outfit[];
	parts?: WardrobePart[];
	locked?: string;
}

const SLOT_MAX = 32;
const ID_MAX = 100;
const NAME_MAX = 100;
const DESCRIPTION_MAX_BYTES = 2000;

/**
 * Normalize a slot name to the shared slug style (lowercase, letters/digits/
 * hyphen). Empty or >32-character results are rejected, not truncated.
 */
export function normalizeWardrobeSlot(value: string): string {
	const slot = value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.trim()
		.replace(/\s+/g, "-");
	if (!slot || slot.length > SLOT_MAX) throw new Error("Invalid wardrobe slot");
	return slot;
}

function isNormalizedSlot(slot: string): boolean {
	try {
		return normalizeWardrobeSlot(slot) === slot;
	} catch {
		return false;
	}
}

/** Truncate on a character boundary so a synthesized description always fits the byte budget. */
function fitDescription(text: string): string {
	if (Buffer.byteLength(text) <= DESCRIPTION_MAX_BYTES) return text;
	let fitted = "";
	for (const char of text) {
		if (Buffer.byteLength(fitted + char) > DESCRIPTION_MAX_BYTES) break;
		fitted += char;
	}
	return fitted;
}

/** Synthesize a stable outfit description: one `slot — name：description` line per selected part, sorted by slot. */
export function partDescription(outfit: Outfit, parts: WardrobePart[]): string {
	const catalog = new Map(parts.map((part) => [part.id, part]));
	const mapping = outfit.parts ?? {};
	const lines = Object.keys(mapping)
		.sort()
		.map((slot) => {
			const part = catalog.get(mapping[slot]);
			return part ? `${slot} — ${part.name}：${part.description}` : slot;
		});
	return fitDescription(lines.join("\n"));
}

/** Display name for a part combination: part names joined by slot order. */
export function combinationName(mapping: Record<string, string>, parts: WardrobePart[]): string {
	const catalog = new Map(parts.map((part) => [part.id, part]));
	const names = Object.keys(mapping)
		.sort()
		.map((slot) => catalog.get(mapping[slot])?.name ?? mapping[slot]);
	return Array.from(names.join(" × ")).slice(0, NAME_MAX).join("");
}

/** Deterministic id for a slot->part mapping: first ten hex chars of SHA-256 over sorted slot:part pairs. */
export function combinationId(parts: Record<string, string>): string {
	const canonical = Object.keys(parts)
		.sort()
		.map((slot) => `${slot}:${parts[slot]}`)
		.join("\n");
	return `combo-${createHash("sha256").update(canonical).digest("hex").slice(0, 10)}`;
}

/** Validate a parsed wardrobe.json value: legacy files load identically, part references must resolve. */
function parseWardrobe(value: unknown): Wardrobe {
	if (!value || typeof value !== "object" || !Array.isArray((value as { outfits?: unknown }).outfits))
		throw new Error("Invalid wardrobe configuration");
	const source = value as { outfits: unknown[]; parts?: unknown; locked?: unknown };
	const parts: WardrobePart[] = [];
	if (source.parts !== undefined) {
		if (!Array.isArray(source.parts)) throw new Error("Invalid wardrobe parts");
		for (const item of source.parts) {
			if (!item || typeof item !== "object") throw new Error("Invalid wardrobe part");
			const part = item as Record<string, unknown>;
			if ("enabled" in part && part.enabled === false) continue;
			const id = "id" in part && typeof part.id === "string" ? part.id : "";
			if (
				!id ||
				id.length > ID_MAX ||
				!("name" in part) ||
				typeof part.name !== "string" ||
				!part.name ||
				part.name.length > NAME_MAX ||
				!("description" in part) ||
				typeof part.description !== "string" ||
				Buffer.byteLength(part.description) > DESCRIPTION_MAX_BYTES ||
				!("slot" in part) ||
				typeof part.slot !== "string" ||
				parts.some((existing) => existing.id === id)
			)
				throw new Error(`Invalid wardrobe part: ${id || "(unnamed)"}`);
			let slot: string;
			try {
				slot = normalizeWardrobeSlot(part.slot);
			} catch {
				throw new Error(`Invalid wardrobe part slot: ${id}`);
			}
			parts.push({ id, slot, name: part.name, description: part.description });
		}
	}
	const catalog = new Map(parts.map((part) => [part.id, part]));
	const outfits: Outfit[] = [];
	for (const item of source.outfits) {
		if (!item || typeof item !== "object") throw new Error("Invalid wardrobe outfit");
		const entry = item as Record<string, unknown>;
		if ("enabled" in entry && entry.enabled === false) continue;
		const id = "id" in entry && typeof entry.id === "string" ? entry.id : "";
		const name = "name" in entry && typeof entry.name === "string" ? entry.name : "";
		if (!id || id.length > ID_MAX || !name || name.length > NAME_MAX || outfits.some((outfit) => outfit.id === id))
			throw new Error(`Invalid wardrobe outfit: ${id || "(unnamed)"}`);
		let mapping: Record<string, string> | undefined;
		if ("parts" in entry && entry.parts !== undefined) {
			if (typeof entry.parts !== "object" || entry.parts === null || Array.isArray(entry.parts))
				throw new Error(`Invalid wardrobe outfit: ${id}`);
			const resolved: Record<string, string> = {};
			for (const [slot, partId] of Object.entries(entry.parts as Record<string, unknown>)) {
				if (typeof partId !== "string" || !isNormalizedSlot(slot))
					throw new Error(`Invalid wardrobe outfit: ${id}`);
				if (!catalog.has(partId)) throw new Error(`Outfit ${id} references unknown part ${partId}`);
				resolved[slot] = partId;
			}
			if (Object.keys(resolved).length) mapping = resolved;
		}
		// A description may be omitted (or left empty) only with a non-empty parts mapping.
		const description =
			"description" in entry && typeof entry.description === "string" && (entry.description || !mapping)
				? entry.description
				: undefined;
		if (description !== undefined && Buffer.byteLength(description) > DESCRIPTION_MAX_BYTES)
			throw new Error(`Invalid wardrobe outfit: ${id}`);
		if (description === undefined && !mapping) throw new Error(`Invalid wardrobe outfit: ${id}`);
		let generated: boolean | undefined;
		if ("generated" in entry && entry.generated !== undefined) {
			if (typeof entry.generated !== "boolean") throw new Error(`Invalid wardrobe outfit: ${id}`);
			generated = entry.generated;
		}
		outfits.push({
			id,
			name,
			description:
				description ??
				partDescription({ id, name, description: "", ...(mapping ? { parts: mapping } : {}) }, parts),
			...(mapping ? { parts: mapping } : {}),
			...(generated ? { generated } : {}),
		});
	}
	const locked = source.locked;
	if (locked !== undefined && (typeof locked !== "string" || !outfits.some((outfit) => outfit.id === locked)))
		throw new Error("Locked outfit must name an enabled outfit");
	return { ...(parts.length ? { parts } : {}), outfits, ...(typeof locked === "string" ? { locked } : {}) };
}

export function loadWardrobe(root = getAgentDir()): Wardrobe {
	const value = readState(join(root, "persona", "wardrobe.json"));
	if (value === undefined) return { outfits: [] };
	return parseWardrobe(value);
}

/**
 * Serialize a wardrobe for writing, validating with the same rules the
 * loader enforces — callers (the wardrobe tool) cannot produce a file the
 * loader would reject.
 */
export function buildWardrobeFile(wardrobe: Wardrobe): string {
	const file = {
		...(wardrobe.parts?.length ? { parts: wardrobe.parts } : {}),
		outfits: wardrobe.outfits.map((outfit) => ({
			id: outfit.id,
			name: outfit.name,
			description: outfit.description,
			...(outfit.parts && Object.keys(outfit.parts).length ? { parts: outfit.parts } : {}),
			...(outfit.generated ? { generated: true } : {}),
		})),
		...(wardrobe.locked ? { locked: wardrobe.locked } : {}),
	};
	const json = `${JSON.stringify(file, null, "\t")}\n`;
	parseWardrobe(JSON.parse(json));
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
