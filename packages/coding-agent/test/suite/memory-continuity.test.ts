import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { getMemoryChannel } from "../../src/core/memory/channel.ts";
import { ContinuityStore } from "../../src/core/memory/continuity.ts";
import { getRuntimeState } from "../../src/core/runtime/state-db.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import memoryExtension from "../../src/extensions/memory/index.ts";
import { createHarness, getUserTexts } from "./harness.ts";

function enableReflection(): void {
	// Reflection is opt-in; the agent-level runtime.json turns it on.
	writeFileSync(join(getAgentDir(), "runtime.json"), JSON.stringify({ memoryReflection: true }));
}

it("catalogs scoped memory on version change without auto-recall, then shares continuity", async () => {
	const first = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(first.tempDir, "global"));
	const harness = await createHarness({ extensionFactories: [{ name: "memory", factory: memoryExtension }] });
	let other: Awaited<ReturnType<typeof createHarness>> | undefined;
	try {
		enableReflection();
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
		const channel = getMemoryChannel();
		const record = channel
			.store({ scope: "persona" })
			.list(true)
			.find((r) => r.title === "Tea preference");
		expect(record?.body).toBe("The user prefers jasmine tea.");
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(1);

		other = await createHarness({ extensionFactories: [{ name: "memory", factory: memoryExtension }] });
		let userPrompt = "";
		let system = "";
		other.setResponses([
			(context) => {
				system = getCurrentSystemPrompt(context.messages);
				userPrompt = getUserTexts(other!).at(-1) ?? "";
				return fauxAssistantMessage("Jasmine tea.");
			},
		]);
		await other.session.prompt("Which tea did I prefer?");
		// First delivery is a per-record baseline: full record content with
		// its scope heading, so the model needs no keyword recall to answer.
		expect(userPrompt).toContain("### Memory baseline: persona");
		expect(userPrompt).toContain("Tea preference");
		expect(userPrompt).toContain("profile");
		expect(userPrompt).toContain("The user prefers jasmine tea.");
		expect(system).not.toContain("jasmine");
		// Persona continuity carries the shared interaction stage.
		expect(userPrompt).toContain("We are choosing tea");
		expect(new ContinuityStore(getRuntimeState(), { scope: "persona" }).context()).toContain("choosing tea");
		// Second message in the same session: no record changed, so neither a
		// baseline nor an update section is re-sent.
		other.setResponses([fauxAssistantMessage("Still jasmine.")]);
		await other.session.prompt("And now?");
		const repeated = getUserTexts(other).at(-1) ?? "";
		expect(repeated).not.toContain("### Memory baseline");
		expect(repeated).not.toContain("### Memory update");
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
		enableReflection();
		getMemoryChannel().write({
			type: "profile",
			title: "stable",
			body: "Confirmed fact",
			source: "user",
			scope: { scope: "persona" },
		});
		harness.setResponses([fauxAssistantMessage("Answer"), fauxAssistantMessage("invalid json")]);
		await harness.session.prompt("Hello");
		expect(
			getMemoryChannel()
				.store({ scope: "persona" })
				.list(true)
				.find((r) => r.title === "stable")?.body,
		).toBe("Confirmed fact");
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
