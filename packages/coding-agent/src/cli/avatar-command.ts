/**
 * `neko-pi avatar [state]` — print a persona avatar frame as truecolor ANSI art.
 *
 * Frames live in the persona pack at <agentDir>/persona/theme/avatar/hd/ans/*.ans
 * (128 columns × 64 lines, half-block truecolor with transparency: single-sided
 * pixels use ▀/▄, empty cells render as bare spaces so the terminal bg shows
 * through). ans64/ holds 64-column variants for compact layouts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

const STATES = [
	"happy_night_desk",
	"angry_night_desk",
	"flustered_night_desk",
	"sad_night_desk",
	"happy_cozy",
	"angry_cozy",
	"flustered_cozy",
	"sad_cozy",
] as const;

const DEFAULT_STATE = "happy_night_desk";

export function handleAvatarCommand(args: string[]): boolean {
	if (args[0] !== "avatar") return false;
	const requested = args[1];
	const state = requested && (STATES as readonly string[]).includes(requested) ? requested : DEFAULT_STATE;
	const path = join(getAgentDir(), "persona", "theme", "avatar", "hd", "ans", `${state}.ans`);
	if (!existsSync(path)) {
		console.log(`No avatar frame for "${state}".\nExpected: ${path}`);
		return true;
	}
	const known = requested && !(STATES as readonly string[]).includes(requested);
	if (known) console.log(`(unknown state "${requested}" — showing ${state})`);
	process.stdout.write(readFileSync(path, "utf-8"));
	return true;
}
