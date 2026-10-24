import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { restoreTurn } from "../../src/core/turn-file-journal.ts";
import undoJournalExtension from "../../src/extensions/undo-journal/index.ts";
import { createHarness, getUserTexts } from "./harness.ts";

/**
 * End-to-end: a write tool inside a real turn snapshots the file it changes;
 * restoring the turn's journal returns the file to its pre-turn content and
 * removes the turn from the live context.
 */
it("undo journal snapshots write-tool targets and restores them per turn", async () => {
	const root = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(root.tempDir, "home"));
	const work = join(root.tempDir, "work");
	mkdirSync(work, { recursive: true });
	const target = join(work, "poem.txt");
	writeFileSync(target, "original line");

	const manager = SessionManager.create(work, work);
	const harness = await createHarness({
		sessionManager: manager,
		extensionFactories: [{ name: "undo-journal", factory: undoJournalExtension }],
	});
	try {
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
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});
