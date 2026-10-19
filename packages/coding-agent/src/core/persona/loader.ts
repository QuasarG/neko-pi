/**
 * Persona pack discovery and loading.
 *
 * A persona pack is a directory with a persona.md identity file and optional
 * supporting resources (voice/style.md, memory/manifest.json, theme/). The
 * harness only defines the mechanism; all persona content lives in the pack.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { PersonaPrompt } from "../system-prompt.ts";

export interface PersonaPack extends PersonaPrompt {
	/** Display name derived from the pack directory. */
	name: string;
	/** Absolute path of the pack root. */
	root: string;
}

/** Default user-level persona pack directory: ~/.pi/agent/persona */
export function personaPackDir(): string {
	return join(homedir(), CONFIG_DIR_NAME, "agent", "persona");
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

	return { identity, voice, name: basename(root), root };
}
