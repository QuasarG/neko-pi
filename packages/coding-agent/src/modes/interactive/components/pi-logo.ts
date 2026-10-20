import {
	backgroundAnsi,
	foregroundAnsi,
	isAppleTerminalSession,
	type RgbColorValue,
	rgbColor,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const CORAL = rgbColor(228, 138, 122);
const WHITE = rgbColor(245, 240, 235);
const YELLOW = rgbColor(234, 182, 93);
const RESET = "\x1b[0m";

/** Pixel palette for the neko face. */
type Px = "C" | "W" | "Y" | ".";

function colorFor(px: Exclude<Px, ".">): RgbColorValue {
	switch (px) {
		case "C":
			return CORAL;
		case "W":
			return WHITE;
		case "Y":
			return YELLOW;
	}
}

/**
 * The neko logo: 8 columns wide and 2 lines tall (4 pixel rows via half blocks) —
 * a tiny cat face with coral ears, a white face, yellow eyes and a little mouth:
 *
 *   . C . . . C . .
 *   . C W W W W C .
 *   C W Y W W Y W C
 *   C W W Y W W W C
 *
 * Brand colors stay fixed across themes; they follow the terminal's color mode.
 */
const NEKO_FACE: Px[][] = [
	[".", "C", ".", ".", ".", "C", ".", "."],
	[".", "C", "W", "W", "W", "W", "C", "."],
	["C", "W", "Y", "W", "W", "Y", "W", "C"],
	["C", "W", "W", "Y", "W", "W", "W", "C"],
];

/** Render pixel rows [top, bottom] into one ANSI line of half blocks. */
function pixelLine(top: Px[], bottom: Px[]): string {
	let out = "";
	for (let col = 0; col < top.length; col++) {
		const a = top[col];
		const b = bottom[col];
		const ca = a === "." ? undefined : colorFor(a);
		const cb = b === "." ? undefined : colorFor(b);
		if (ca && cb) {
			out += `${foregroundAnsi(cb, theme.getColorMode())}${backgroundAnsi(ca, theme.getColorMode())}▄${RESET}`;
		} else if (ca) {
			out += `${foregroundAnsi(ca, theme.getColorMode())}▀${RESET}`;
		} else if (cb) {
			out += `${foregroundAnsi(cb, theme.getColorMode())}▄${RESET}`;
		} else {
			out += " ";
		}
	}
	return out;
}

/** The neko logo: a two-line ANSI cat face. */
export function piLogoLines(): [string, string] {
	const line1 = pixelLine(NEKO_FACE[0], NEKO_FACE[1]);
	const line2 = pixelLine(NEKO_FACE[2], NEKO_FACE[3]);
	return [line1, line2];
}

/**
 * Whether the terminal renders the half-block logo correctly. Apple Terminal draws gaps between rows and
 * misaligns the half blocks, so it gets the text wordmark instead.
 */
export function supportsPiLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback for the logo: "neko-pi" with the logo's coral and yellow. */
export function piWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(CORAL, mode)}neko${RESET}-${foregroundAnsi(YELLOW, mode)}pi${RESET}`;
}
