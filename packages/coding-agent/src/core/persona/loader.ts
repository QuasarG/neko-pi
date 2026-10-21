/**
 * Persona pack discovery and loading.
 *
 * A persona pack is a directory with a persona.md identity file and optional
 * supporting resources (voice/style.md, memory/manifest.json, theme/). The
 * harness only defines the mechanism; all persona content lives in the pack.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { PersonaPrompt } from "../system-prompt.ts";

export interface PersonaPack extends PersonaPrompt {
	/** Display name derived from the pack directory. */
	name: string;
	/** Absolute path of the pack root. */
	root: string;
	/** When this pack was loaded into the process, for status display. */
	loadedAt: Date;
}

/** Default user-level persona pack directory: ~/.neko_pi/persona */
export function personaPackDir(): string {
	return join(getAgentDir(), "persona");
}

/**
 * Load the active persona pack. A directory counts as a pack when it contains
 * a non-empty persona.md. Returns null when no pack is installed; callers
 * decide whether that is an error or a default-identity session.
 */
export function loadPersonaPack(root: string = personaPackDir()): PersonaPack | null {
	const personaPath = join(root, "persona.md");
	if (!existsSync(personaPath)) return null;
	const identity = readFileSync(personaPath, "utf-8").trim();
	if (!identity) return null;

	let voice: string | undefined;
	const voicePath = join(root, "voice", "style.md");
	if (existsSync(voicePath)) {
		voice = readFileSync(voicePath, "utf-8").trim() || undefined;
	}

	// Optional manifest.json supplies a display name; fall back to the directory name.
	let name = basename(root);
	const manifestPath = join(root, "manifest.json");
	if (existsSync(manifestPath)) {
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name?: unknown };
			if (typeof manifest.name === "string" && manifest.name.trim()) name = manifest.name.trim();
		} catch {
			// Malformed manifest: keep the directory-derived name.
		}
	}

	return { identity, voice, name, root, loadedAt: new Date() };
}
