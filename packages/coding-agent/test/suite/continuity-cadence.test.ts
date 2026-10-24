import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { personaContinuityCadence } from "../../src/core/memory/cadence.ts";
import { ContinuityStore } from "../../src/core/memory/continuity.ts";
import { getRuntimeState } from "../../src/core/runtime/state-db.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { truncateNativeSession } from "../../src/core/session-truncate.ts";
import memoryExtension from "../../src/extensions/memory/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const factories = [{ name: "memory", factory: memoryExtension }];
let root: string;
const harnesses: Harness[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "continuity-cadence-"));
	vi.stubEnv("NEKO_PI_HOME", root);
});
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

async function setup(manager?: SessionManager): Promise<Harness> {
	const harness = await createHarness({
		extensionFactories: factories,
		sessionManager: manager,
		settings: { retry: { enabled: false } },
	});
	harnesses.push(harness);
	return harness;
}

const update = (summary: string, scope: "persona" | "project" = "persona") =>
	fauxAssistantMessage(fauxToolCall("continuity_update", { summary, scope }), { stopReason: "toolUse" });

test("checkpoint is in-turn: a skipped query leaves due set, the next query's write clears it", async () => {
	const harness = await setup();
	// q1, q2: plain turns, no checkpoint.
	for (const q of ["q1", "q2"]) {
		harness.setResponses([fauxAssistantMessage("a:" + q)]);
		await harness.session.prompt(q);
		expect(personaContinuityCadence(harness.sessionManager).due).toBe(false);
	}
	// q3 skips the write: the turn settles normally, no harness continuation —
	// but the checkpoint stays owed.
	harness.setResponses([fauxAssistantMessage("forgot this time")]);
	await harness.session.prompt("q3 skipped");
	const continuations = harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "continuity.required");
	expect(continuations).toHaveLength(0);
	expect(personaContinuityCadence(harness.sessionManager)).toEqual({ queries: 3, block: 1, due: true });
	// q4 carries the requirement again; a real persona write clears it in-turn.
	harness.setResponses([update("Recovered stage."), fauxAssistantMessage("done")]);
	await harness.session.prompt("q4 catches up");
	expect(personaContinuityCadence(harness.sessionManager)).toEqual({ queries: 4, block: 1, due: false });
	expect(new ContinuityStore().read()?.summary).toBe("Recovered stage.");
});

test("cadence survives restart, is session-scoped, and carries failed checkpoint debt forward", async () => {
	const manager = SessionManager.create(root, join(root, "sessions"));
	const first = await setup(manager);
	for (const text of ["one", "two"]) {
		first.setResponses([fauxAssistantMessage("answer")]);
		await first.session.prompt(text);
	}
	const second = await setup(SessionManager.open(manager.getSessionFile()!));
	second.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "request rejected" })]);
	await second.session.prompt("three");
	expect(personaContinuityCadence(second.sessionManager)).toEqual({ queries: 3, block: 1, due: true });
	const other = await setup();
	other.setResponses([fauxAssistantMessage("unrelated answer")]);
	await other.session.prompt("other session one");
	expect(personaContinuityCadence(other.sessionManager)).toEqual({ queries: 1, block: 0, due: false });
	second.setResponses([update("Recovered stage."), fauxAssistantMessage("done")]);
	await second.session.prompt("four");
	expect(personaContinuityCadence(second.sessionManager)).toEqual({ queries: 4, block: 1, due: false });
});

test("internal prompts do not advance cadence, and same receipt retries count once", async () => {
	const harness = await setup();
	harness.setResponses([
		fauxAssistantMessage("answer"),
		fauxAssistantMessage("internal answer"),
		fauxAssistantMessage("retry answer"),
	]);
	await harness.session.prompt("one", { received: { time: 1, messageId: "same-query" } });
	await harness.session.prompt("internal", { source: "extension" });
	await harness.session.prompt("one", { received: { time: 1, messageId: "same-query" } });
	expect(personaContinuityCadence(harness.sessionManager)).toEqual({ queries: 1, block: 0, due: false });
});

test("a new fork counts its own queries and truncation removes the discarded checkpoint", async () => {
	const manager = SessionManager.create(root, join(root, "sessions"));
	const harness = await setup(manager);
	for (const text of ["one", "two"]) {
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt(text);
	}
	const fork = SessionManager.forkFrom(manager.getSessionFile()!, root, join(root, "forks"));
	expect(personaContinuityCadence(fork)).toEqual({ queries: 0, block: 0, due: false });
	const other = await setup(fork);
	other.setResponses([fauxAssistantMessage("fork answer")]);
	await other.session.prompt("fork one");
	expect(personaContinuityCadence(other.sessionManager)).toEqual({ queries: 1, block: 0, due: false });
	harness.setResponses([update("Third query checkpoint."), fauxAssistantMessage("done")]);
	await harness.session.prompt("three");
	const target = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user")!;
	await truncateNativeSession(harness.session, target.id);
	expect(personaContinuityCadence(manager)).toEqual({ queries: 2, block: 0, due: false });
	expect(
		manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "continuity.persona.saved"),
	).toBe(false);
});

test("a stale persona write stays due until an explicit merge against the current version succeeds", async () => {
	const harness = await setup();
	for (const text of ["one", "two"]) {
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt(text);
	}
	const store = new ContinuityStore(getRuntimeState());
	harness.setResponses([
		() => {
			const revision = store.claim("other");
			expect(store.commit(revision, "Other session stage.")).toBe(true);
			return update("Stale stage.");
		},
		() => {
			expect(personaContinuityCadence(harness.sessionManager).due).toBe(true);
			return fauxAssistantMessage(
				fauxToolCall("continuity_update", {
					summary: "Other session stage; current discussion continues.",
					expected_version: store.read()!.version,
				}),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("three");
	expect(personaContinuityCadence(harness.sessionManager).due).toBe(false);
	const results = harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map(getMessageText)
		.join("\n");
	expect(results).toContain("Not saved: a newer session is active");
	expect(results).toContain("Continuity updated.");
});
