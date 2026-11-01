import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "../config.ts";

/**
 * Per-turn file journal for `/undo`: before a write/edit tool touches a file,
 * its original content is snapshotted; undoing the turn restores every
 * snapshot and deletes files the turn created. Only the LAST turn is kept —
 * a new user turn wipes its previous journal, so disk cost is one turn's files and
 * undo scope is exactly "the latest round".
 */

function journalRoot(): string {
	return join(getAgentDir(), "sessions", "undo");
}

function turnDir(turnKey: string): string {
	if (!turnKey) throw new Error("Turn ID is required");
	return join(journalRoot(), turnKey.replace(/[^a-zA-Z0-9_-]/g, "_"));
}

/** A new user turn resets only its own session's previous undo scope. */
export function clearTurnJournal(turnKey: string): void {
	rmSync(turnDir(turnKey), { recursive: true, force: true });
}

/**
 * Snapshot a file before the turn modifies it. The FIRST snapshot wins: a
 * file written twice in one turn restores to its pre-turn state.
 */
export function recordOriginal(turnKey: string, path: string): void {
	const dir = turnDir(turnKey);
	const encoded = Buffer.from(resolve(path), "utf8").toString("base64url");
	const target = join(dir, "files", encoded);
	const marker = join(dir, "created", encoded);
	if (existsSync(target) || existsSync(marker)) return;
	if (existsSync(path)) {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, readFileSync(path));
	} else {
		mkdirSync(dirname(marker), { recursive: true });
		writeFileSync(marker, "");
	}
}

/** Restore every snapshot taken for a turn. Returns what was undone. */
export function restoreTurn(turnKey: string): { restored: string[]; deleted: string[] } {
	const dir = turnDir(turnKey);
	const restored: string[] = [];
	const deleted: string[] = [];
	const filesDir = join(dir, "files");
	if (existsSync(filesDir)) {
		for (const name of readdirSync(filesDir)) {
			const path = Buffer.from(name, "base64url").toString("utf8");
			writeFileSync(path, readFileSync(join(filesDir, name)));
			restored.push(path);
		}
	}
	const createdDir = join(dir, "created");
	if (existsSync(createdDir)) {
		for (const name of readdirSync(createdDir)) {
			const path = Buffer.from(name, "base64url").toString("utf8");
			rmSync(path, { force: true });
			deleted.push(path);
		}
	}
	rmSync(dir, { recursive: true, force: true });
	return { restored, deleted };
}
