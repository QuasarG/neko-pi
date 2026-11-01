import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CustomMessage } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import askUserExtension from "../../src/extensions/ask-user/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const factories = [{ name: "ask-user", factory: askUserExtension }];
let root: string;
const harnesses: Harness[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "system-tool-repair-suite-"));
	vi.stubEnv("NEKO_PI_HOME", root);
});
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** A transcript written by a host without the ask-user extension: it recorded the removal. */
function poisonedSessionManager(): SessionManager {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({
		role: "system",
		content: "",
		toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object" } }],
		timestamp: Date.now(),
	});
	sessionManager.appendMessage({
		role: "system",
		content: "",
		toolsRemoved: [{ name: "ask_user" }],
		timestamp: Date.now(),
	});
	sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	return sessionManager;
}

// Root cause of "Tool memory_write not found" in web sessions: a transcript that
// once lacked a tool keeps it inactive on every replay; the before_agent_start
// self-repair must bring it back on the next turn.
test("the self-repair reactivates a poisoned system tool on the next turn", async () => {
	const harness = await createHarness({ extensionFactories: factories, sessionManager: poisonedSessionManager() });
	harnesses.push(harness);
	// The sticky restore keeps the frozen removal: inactive right after resume.
	expect(harness.session.getActiveToolNames()).not.toContain("ask_user");

	harness.setResponses([fauxAssistantMessage("done")]);
	await harness.session.prompt("hi");

	expect(harness.session.getActiveToolNames()).toContain("ask_user");
	const marker = harness.session.messages.findLast(
		(message): message is CustomMessage =>
			message.role === "custom" && (message as { customType?: string }).customType === "toolset-update",
	);
	expect(getMessageText(marker)).toContain("+ask_user");
});
