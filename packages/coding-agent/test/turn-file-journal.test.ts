import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearTurnJournal, recordOriginal, restoreTurn } from "../src/core/turn-file-journal.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "neko-undo-"));
	vi.stubEnv("NEKO_PI_HOME", join(root, "home"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

test("restore returns modified files to pre-turn state and deletes created ones", () => {
	const changed = join(root, "changed.txt");
	const created = join(root, "sub", "created.txt");
	mkdirSync(join(root, "sub"), { recursive: true });
	writeFileSync(changed, "original");
	recordOriginal("turn1", changed);
	recordOriginal("turn1", created);
	// The turn modifies both.
	writeFileSync(changed, "modified by the turn");
	writeFileSync(created, "brand new");
	// A second snapshot of the same file must not overwrite the first.
	recordOriginal("turn1", changed);
	writeFileSync(changed, "modified twice");

	const result = restoreTurn("turn1");
	expect(readFileSync(changed, "utf8")).toBe("original");
	expect(existsSync(created)).toBe(false);
	expect(result.restored).toEqual([changed]);
	expect(result.deleted).toEqual([created]);
});

test("a new turn clears the journal: undo scope is exactly the last round", () => {
	const file = join(root, "a.txt");
	writeFileSync(file, "v0");
	recordOriginal("turn1", file);
	writeFileSync(file, "v1");

	clearTurnJournal();
	writeFileSync(file, "v2");
	recordOriginal("turn2", file);
	writeFileSync(file, "v3");

	const result = restoreTurn("turn2");
	expect(result.restored).toEqual([file]);
	// Restored to the START of turn2 (v2), not turn1 (v0): older snapshots are gone.
	expect(readFileSync(file, "utf8")).toBe("v2");
	// Turn1's directory no longer exists.
	expect(restoreTurn("turn1")).toEqual({ restored: [], deleted: [] });
});
