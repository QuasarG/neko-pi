import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MEMORY_RULE_SECTION, MEMORY_UPDATE_INTERVAL, memoryUpdateCadence } from "../../src/core/memory/cadence.ts";
import memoryExtension from "../../src/extensions/memory/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const factories = [{ name: "memory", factory: memoryExtension }];
let root: string;
const harnesses: Harness[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "memory-cadence-"));
	vi.stubEnv("NEKO_PI_HOME", root);
});
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

async function setup(): Promise<Harness> {
	const harness = await createHarness({
		extensionFactories: factories,
		settings: { retry: { enabled: false } },
	});
	harnesses.push(harness);
	return harness;
}

const memWrite = (title: string) =>
	fauxAssistantMessage(fauxToolCall("memory_write", { type: "episode", title, body: `fact ${title}` }), {
		stopReason: "toolUse",
	});

test("memory checkpoint comes due every ten queries and any successful write clears it", async () => {
	expect(MEMORY_UPDATE_INTERVAL).toBe(10);
	const harness = await setup();
	for (let index = 1; index <= 9; index++) {
		harness.setResponses([fauxAssistantMessage(`a${index}`)]);
		await harness.session.prompt(`q${index}`);
		expect(memoryUpdateCadence(harness.sessionManager).due).toBe(false);
	}
	// The tenth query makes the checkpoint owed; skipping keeps it owed.
	harness.setResponses([fauxAssistantMessage("a10")]);
	await harness.session.prompt("q10 skipped");
	expect(memoryUpdateCadence(harness.sessionManager)).toEqual({ queries: 10, block: 1, due: true });
	harness.setResponses([fauxAssistantMessage("a11")]);
	await harness.session.prompt("q11 still owed");
	expect(memoryUpdateCadence(harness.sessionManager).due).toBe(true);
	// A successful memory_write satisfies the checkpoint in-turn.
	harness.setResponses([memWrite("checkpoint-fact"), fauxAssistantMessage("done")]);
	await harness.session.prompt("q12 catches up");
	expect(memoryUpdateCadence(harness.sessionManager)).toEqual({ queries: 12, block: 1, due: false });
});

test("the memory checkpoint requirement points at the hygiene skill", () => {
	expect(MEMORY_RULE_SECTION).toContain("memory-hygiene");
	expect(MEMORY_RULE_SECTION).toContain("memory_write");
});
