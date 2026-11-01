import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { restoreTurn } from "../../src/core/turn-file-journal.ts";
import undoJournalExtension from "../../src/extensions/undo-journal/index.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

let root: string;
const harnesses: Harness[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "undo-journal-suite-"));
	vi.stubEnv("NEKO_PI_HOME", join(root, "home"));
});
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/**
 * End-to-end: a write tool inside a real turn snapshots the file it changes;
 * restoring the turn's journal returns the file to its pre-turn content and
 * removes the turn from the live context.
 */
it("undo journal snapshots write-tool targets and restores them per turn", async () => {
	const work = join(root, "work");
	mkdirSync(work, { recursive: true });
	const target = join(work, "poem.txt");
	writeFileSync(target, "original line");

	const manager = SessionManager.create(work, work);
	const harness = await createHarness({
		sessionManager: manager,
		extensionFactories: [{ name: "undo-journal", factory: undoJournalExtension }],
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: target, content: "clobbered by the turn" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("written"),
	]);
	await harness.session.prompt("overwrite the poem");
	expect(readFileSync(target, "utf8")).toBe("clobbered by the turn");

	// The journal holds the pre-turn content under the turn's user entry.
	const users = manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user");
	const restored = restoreTurn(users[users.length - 1]!.id);
	expect(restored.restored).toEqual([target]);
	expect(readFileSync(target, "utf8")).toBe("original line");
	expect(getUserTexts(harness)).toEqual(["overwrite the poem"]);
});

it("relative-path undo journals stay with their session when another Web session runs", async () => {
	const a = await createHarness({ extensionFactories: [{ name: "undo-journal", factory: undoJournalExtension }] });
	const b = await createHarness({ extensionFactories: [{ name: "undo-journal", factory: undoJournalExtension }] });
	harnesses.push(a, b);
	for (const [harness, initial] of [
		[a, "A original"],
		[b, "B original"],
	] as const) {
		writeFileSync(join(harness.tempDir, "note.txt"), initial);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: "changed" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("written"),
		]);
		await harness.session.prompt("write the project note");
		expect(readFileSync(join(harness.tempDir, "note.txt"), "utf8")).toBe("changed");
	}
	const aTurn = a.sessionManager
		.getBranch()
		.findLast((entry) => entry.type === "message" && entry.message.role === "user")!;
	const bTurn = b.sessionManager
		.getBranch()
		.findLast((entry) => entry.type === "message" && entry.message.role === "user")!;
	// Another turn in A must retire A's snapshot without touching B's.
	a.setResponses([fauxAssistantMessage("next turn")]);
	await a.session.prompt("continue in A");
	expect(restoreTurn(aTurn.id)).toEqual({ restored: [], deleted: [] });
	expect(restoreTurn(bTurn.id).restored).toEqual([join(b.tempDir, "note.txt")]);
	expect(readFileSync(join(b.tempDir, "note.txt"), "utf8")).toBe("B original");
});
