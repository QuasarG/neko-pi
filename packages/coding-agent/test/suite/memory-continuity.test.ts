import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { ContinuityStore } from "../../src/core/memory/continuity.ts";
import { getMemoryStore } from "../../src/core/memory/store.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import memoryExtension from "../../src/extensions/memory/index.ts";
import { createHarness } from "./harness.ts";

it("extracts bounded memory without exposing maintenance text, then recalls it in a new session", async () => {
	const first = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(first.tempDir, "global"));
	const harness = await createHarness({ extensionFactories: [{ name: "memory", factory: memoryExtension }] });
	let other: Awaited<ReturnType<typeof createHarness>> | undefined;
	try {
		harness.setResponses([
			fauxAssistantMessage("I will remember your tea preference."),
			fauxAssistantMessage(
				JSON.stringify({
					summary: "We are choosing tea; keep a calm, familiar tone.",
					memories: [{ type: "profile", title: "Tea preference", body: "The user prefers jasmine tea." }],
				}),
			),
		]);
		await harness.session.prompt("I prefer jasmine tea.");
		expect(getMemoryStore().list(true)[0]?.body).toBe("The user prefers jasmine tea.");
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		other = await createHarness({ extensionFactories: [{ name: "memory", factory: memoryExtension }] });
		let system = "";
		other.setResponses([
			(context) => {
				system = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage("Jasmine tea.");
			},
			fauxAssistantMessage('{"summary":"We have chosen jasmine tea.","memories":[]}'),
		]);
		await other.session.prompt("Which tea did I prefer?");
		expect(system).toContain("The user prefers jasmine tea.");
		expect(system).toContain("We are choosing tea");
		expect(new ContinuityStore(getMemoryStore().dir).context()).toContain("chosen jasmine tea");
	} finally {
		other?.cleanup();
		harness.cleanup();
		first.cleanup();
		vi.unstubAllEnvs();
	}
});

it("keeps existing memory when the summary model returns invalid data", async () => {
	const root = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(root.tempDir, "global"));
	const harness = await createHarness({ extensionFactories: [{ name: "memory", factory: memoryExtension }] });
	try {
		getMemoryStore().write({ type: "profile", title: "stable", body: "Confirmed fact", source: "user" });
		harness.setResponses([fauxAssistantMessage("Answer"), fauxAssistantMessage("invalid json")]);
		await harness.session.prompt("Hello");
		expect(getMemoryStore().list(true)[0]?.body).toBe("Confirmed fact");
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});

it("restores the native conversation when reopening its persisted session file", async () => {
	const root = await createHarness();
	const first = await createHarness({
		sessionManager: SessionManager.create(root.tempDir, join(root.tempDir, "sessions")),
	});
	let second: Awaited<ReturnType<typeof createHarness>> | undefined;
	try {
		first.setResponses([fauxAssistantMessage("The agreed marker is remembered.")]);
		await first.session.prompt("Remember the marker RESTART_MARKER.");
		const file = first.sessionManager.getSessionFile();
		expect(file).toBeTruthy();
		second = await createHarness({ sessionManager: SessionManager.open(file!) });
		let recalled = false;
		second.setResponses([
			(context) => {
				recalled = JSON.stringify(context.messages).includes("RESTART_MARKER");
				return fauxAssistantMessage("Restored.");
			},
		]);
		await second.session.prompt("Continue our earlier conversation.");
		expect(recalled).toBe(true);
	} finally {
		second?.cleanup();
		first.cleanup();
		root.cleanup();
	}
});
