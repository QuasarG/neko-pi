import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { truncateNativeSession } from "../../src/core/session-truncate.ts";
import { createHarness, getUserTexts } from "./harness.ts";

/**
 * /edit's core primitive in the native path: truncating a user turn removes
 * it (and everything after) from the LIVE context and the persisted file,
 * keeps the session identity and parent chain intact, and leaves the
 * delivered-injection wrapper out of the composer refill.
 */
it("truncate removes the chosen user turn from live context and disk, keeping identity", async () => {
	const root = await createHarness();
	const manager = SessionManager.create(root.tempDir, root.tempDir);
	const harness = await createHarness({ sessionManager: manager });
	try {
		harness.setResponses([fauxAssistantMessage("first answer")]);
		await harness.session.prompt("keep me");
		const target = harness.sessionManager.appendMessage({
			role: "user",
			content: "remove me",
			timestamp: Date.now(),
		});
		harness.session.refreshContext();
		const sessionId = harness.sessionManager.getSessionId();
		const file = harness.sessionManager.getSessionFile();

		await truncateNativeSession(harness.session, target);

		expect(harness.sessionManager.getSessionId()).toBe(sessionId);
		expect(getUserTexts(harness)).toEqual(["keep me"]);
		expect(file).toBeDefined();
		for (const entry of harness.sessionManager.getEntries()) {
			if (entry.parentId) expect(harness.sessionManager.getEntry(entry.parentId)).toBeDefined();
		}
	} finally {
		harness.cleanup();
		root.cleanup();
	}
});
