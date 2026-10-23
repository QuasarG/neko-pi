import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { getMemoryChannel } from "../../src/core/memory/channel.ts";
import { getRuntimeState } from "../../src/core/runtime/state-db.ts";
import memoryExtension from "../../src/extensions/memory/index.ts";
import { createHarness, getUserTexts } from "./harness.ts";

const factories = [{ name: "memory", factory: memoryExtension }];

/**
 * A memory file edited outside pi (vim, another process, a sync tool) never
 * reaches the tool_result hook that re-indexes managed writes. The extension
 * scans both scopes before deciding what to inject, so the edit bumps the
 * scope version and the catalog is re-delivered on the very next message.
 */
it("hand edits on disk are detected on the next user message", async () => {
	const root = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(root.tempDir, "global"));
	const harness = await createHarness({ extensionFactories: factories });
	try {
		const channel = getMemoryChannel();
		const persona = { scope: "persona" as const };
		const written = channel.write({
			scope: persona,
			type: "procedure",
			title: "Hand edit probe",
			body: "Original body about a durable fact.",
			source: "user",
		});
		expect(written.action).toBe("created");
		const versionBefore = getRuntimeState().scopeVersion(persona);

		// First message: the catalog is delivered (no receipt yet).
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("first question");
		const firstUser = getUserTexts(harness).at(-1)!;
		expect(firstUser).toContain("<runtime_memory>");
		expect(firstUser).toContain("Hand edit probe");

		// Edit the file directly, the way an external editor would: the DB
		// hash and version do not move on their own.
		const dir = channel.store(persona).dir;
		const file = written.file;
		const path = join(dir, file);
		const raw = readFileSync(path, "utf8");
		expect(raw).toContain("title: Hand edit probe");
		writeFileSync(
			path,
			raw.replace("title: Hand edit probe", "title: Renamed By Hand").replace("Original body", "Edited body"),
		);
		expect(getRuntimeState().scopeVersion(persona)).toBe(versionBefore);
		// Let the file settle past the mid-write window so the next scan
		// registers it (freshly-written files are treated as in-progress).
		await new Promise((resolve) => setTimeout(resolve, 2_200));

		// Next message: the pre-injection scan notices the drift, registers the
		// new content, bumps the scope version, and re-delivers the catalog.
		harness.setResponses([fauxAssistantMessage("second")]);
		await harness.session.prompt("second question");
		const secondUser = getUserTexts(harness).at(-1)!;
		expect(secondUser).toContain("<runtime_memory>");
		expect(secondUser).toContain("Renamed By Hand");
		expect(secondUser).not.toContain("Hand edit probe");
		expect(getRuntimeState().scopeVersion(persona)).toBeGreaterThan(versionBefore);
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});

/**
 * The scan must not re-inject on every message: with no external change the
 * scope version stays put and the receipt suppresses the catalog.
 */
it("an unchanged scope is not re-injected on the next message", async () => {
	const root = await createHarness();
	vi.stubEnv("NEKO_PI_HOME", join(root.tempDir, "global"));
	const harness = await createHarness({ extensionFactories: factories });
	try {
		const channel = getMemoryChannel();
		channel.write({
			scope: { scope: "persona" },
			type: "procedure",
			title: "Stable record",
			body: "Nothing edits this between messages.",
			source: "user",
		});
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first question");
		expect(getUserTexts(harness).at(-1)).toContain("<runtime_memory>");
		await harness.session.prompt("second question");
		// Continuity may repeat only when its content changed; the catalog is
		// gated by the scope version, which did not move.
		expect(getUserTexts(harness).at(-1)).not.toContain("<runtime_memory>");
	} finally {
		harness.cleanup();
		root.cleanup();
		vi.unstubAllEnvs();
	}
});
