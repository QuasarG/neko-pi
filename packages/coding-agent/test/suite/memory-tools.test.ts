import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getMemoryChannel } from "../../src/core/memory/channel.ts";
import { MEMORY_RECORD_RECEIPT, recordReceiptRef } from "../../src/core/memory/delivery.ts";
import type { MEMORY_RECORD_TYPES } from "../../src/core/memory/store.ts";
import { resolveProjectIdentity } from "../../src/core/runtime/identity.ts";
import { getRuntimeState } from "../../src/core/runtime/state-db.ts";
import memoryExtension from "../../src/extensions/memory/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const factories = [{ name: "memory", factory: memoryExtension }];
let root: string;
const harnesses: Harness[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "memory-tools-"));
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

type WriteArgs = {
	type: (typeof MEMORY_RECORD_TYPES)[number];
	title: string;
	body: string;
	scope: "persona" | "project" | "scratch";
	expected_version?: number;
	origin_cwd?: string;
};

const writeCall = (args: WriteArgs) =>
	fauxAssistantMessage(fauxToolCall("memory_write", args), { stopReason: "toolUse" });

const detailsOf = (message: ToolResultMessage): Record<string, unknown> =>
	(message.details ?? {}) as Record<string, unknown>;

const writeResults = (harness: Harness) =>
	harness.session.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "memory_write",
	);

test("memory_write defaults merge version from metadata and reports rich details", async () => {
	const harness = await setup();
	harness.setResponses([
		writeCall({ type: "anchor", title: "server fact", body: "v1 body", scope: "persona" }),
		// No expected_version on the merge: the tool fills it from the current
		// record metadata, so an omitted value still merges instead of conflicting.
		writeCall({ type: "anchor", title: "server fact", body: "v2 body", scope: "persona" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("remember the server fact");
	const results = writeResults(harness);
	expect(results).toHaveLength(2);
	expect(results[0]!.isError).toBe(false);
	const merged = results[1]!;
	expect(merged.isError).toBe(false);
	const details = detailsOf(merged);
	expect(details.action).toBe("merged");
	expect(details.scope).toBe("persona");
	expect(details.version).toBe(2);
	expect(details.previousVersion).toBe(1);
	expect(details.previousBody).toBe("v1 body");
	expect(details.recordId).toMatch(/^rec_/);
	expect(details.title).toBe("server fact");
	expect(details.type).toBe("anchor");
	expect(String(details.absoluteFile)).toContain(join("memory", "persona"));
	expect(String(details.absoluteFile)).toMatch(/\.md$/);
});

test("conflicts and secret rejections are error results the UI can color", async () => {
	const harness = await setup();
	harness.setResponses([
		writeCall({ type: "anchor", title: "guarded fact", body: "v1", scope: "persona" }),
		() => {
			// A concurrent writer merges v2 behind the model's back; the stale
			// explicit expected_version must conflict instead of overwriting.
			const concurrent = getMemoryChannel().write({
				type: "anchor",
				title: "guarded fact",
				body: "v2 concurrent",
				source: "user",
				scope: { scope: "persona" },
			});
			expect(concurrent.action).toBe("merged");
			return writeCall({
				type: "anchor",
				title: "guarded fact",
				body: "v3",
				scope: "persona",
				expected_version: 1,
			});
		},
		writeCall({ type: "anchor", title: "leaky note", body: "token=abcdef123456789", scope: "persona" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("update memory");
	const results = writeResults(harness);
	expect(results).toHaveLength(3);
	expect(results[0]!.isError).toBe(false);
	const conflict = results[1]!;
	expect(conflict.isError).toBe(true);
	expect(getMessageText(conflict)).toContain("conflict");
	expect(detailsOf(conflict)).toMatchObject({ action: "conflict", scope: "persona" });
	const rejected = results[2]!;
	expect(rejected.isError).toBe(true);
	expect(getMessageText(rejected)).toContain("store a reference");
	expect(detailsOf(rejected)).toMatchObject({ action: "rejected", scope: "persona" });
	// The guarded body is the concurrent one and nothing secret was persisted.
	const channel = getMemoryChannel();
	const persona = channel.store({ scope: "persona" }).list(true);
	expect(persona.find((record) => record.title === "guarded fact")?.body).toBe("v2 concurrent");
	expect(persona.find((record) => record.title === "leaky note")).toBeUndefined();
});

test("scratch write and promotion withdraw the source through one tool flow", async () => {
	const harness = await setup();
	const session = harness.sessionManager.getSessionId();
	let scratchRef = "";
	harness.setResponses([
		writeCall({ type: "procedure", title: "external infra", body: "deploy notes", scope: "scratch" }),
		() => {
			const written = writeResults(harness).at(-1)!;
			expect(written.isError).toBe(false);
			const details = detailsOf(written);
			expect(details.scope).toBe("scratch");
			expect(details.action).toBe("created");
			// Self-delivery marked the scratch record's receipt…
			scratchRef = recordReceiptRef({ scope: "scratch" }, String(details.recordId));
			expect(getRuntimeState().getReceipt(session, MEMORY_RECORD_RECEIPT, scratchRef)).toBeDefined();
			return fauxAssistantMessage(
				fauxToolCall("memory_promote", { record_id: String(details.recordId), scope: "project" }),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("keep that infra note in the project");
	// …and promotion withdrew it: no tombstone replays for this session.
	expect(getRuntimeState().getReceipt(session, MEMORY_RECORD_RECEIPT, scratchRef)).toBeUndefined();
	const channel = getMemoryChannel();
	const projectScope = { scope: "project" as const, projectId: resolveProjectIdentity(harness.tempDir).projectId };
	const promoted = channel
		.store(projectScope)
		.list(true)
		.find((record) => record.title === "external infra");
	expect(promoted?.body).toBe("deploy notes");
	expect(channel.store({ scope: "scratch" }).list(true)).toHaveLength(0);
	const promoteResult = getToolResult(harness, "memory_promote");
	expect(promoteResult.isError).toBe(false);
	const details = detailsOf(promoteResult);
	expect(details.action).toBe("created");
	expect(details.fromScope).toBe("scratch");
	expect(details.scope).toBe("project");
	expect(details.version).toBe(1);
	expect(details.title).toBe("external infra");
	expect(String(details.absoluteFile)).toContain(join("memory", "projects"));
});

test("scratch records promote into their origin project across projects", async () => {
	const harness = await setup();
	const otherCwd = join(root, "other-project");
	let scratchId = "";
	harness.setResponses([
		// The fact names a different project through origin_cwd: the write tags
		// targetProjectId so the later promote lands there, not in the cwd project.
		writeCall({
			type: "anchor",
			title: "aitime fact",
			body: "the aitime stack",
			scope: "scratch",
			origin_cwd: otherCwd,
		}),
		() => {
			const written = writeResults(harness).at(-1)!;
			expect(written.isError).toBe(false);
			scratchId = String(detailsOf(written).recordId);
			return fauxAssistantMessage(fauxToolCall("memory_promote", { record_id: scratchId, scope: "project" }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("keep this aitime fact with its own project");
	const channel = getMemoryChannel();
	const otherIdentity = resolveProjectIdentity(otherCwd);
	expect(
		channel
			.store({ scope: "project", projectId: otherIdentity.projectId })
			.list(true)
			.map((record) => record.title),
	).toContain("aitime fact");
	// The cwd project keeps nothing and the scratch copy is withdrawn.
	const currentIdentity = resolveProjectIdentity(harness.tempDir);
	expect(channel.store({ scope: "project", projectId: currentIdentity.projectId }).list(true)).toHaveLength(0);
	expect(channel.store({ scope: "scratch" }).list(true)).toHaveLength(0);
	const result = getToolResult(harness, "memory_promote");
	expect(result.isError).toBe(false);
	expect(detailsOf(result)).toMatchObject({
		action: "created",
		scope: "project",
		projectId: otherIdentity.projectId,
	});
});

test("promotion over an existing target book conflicts until target_version acknowledges it", async () => {
	const harness = await setup();
	// A persona book already holds the topic with richer content the promoting
	// model has never read.
	getMemoryChannel().write({
		type: "anchor",
		title: "shared lesson",
		body: "richer accumulated body",
		source: "user",
		scope: { scope: "persona" },
	});
	let scratchId = "";
	harness.setResponses([
		writeCall({ type: "anchor", title: "shared lesson", body: "draft summary", scope: "scratch" }),
		() => {
			scratchId = String(detailsOf(writeResults(harness).at(-1)!).recordId);
			return fauxAssistantMessage(fauxToolCall("memory_promote", { record_id: scratchId, scope: "persona" }), {
				stopReason: "toolUse",
			});
		},
		// Deferred: the record id only exists once the scratch write's result
		// is in, so this response must be built when consumed, not when queued.
		() =>
			fauxAssistantMessage(
				fauxToolCall("memory_promote", {
					record_id: String(detailsOf(writeResults(harness).at(-1)!).recordId),
					scope: "persona",
					target_version: 1,
				}),
				{ stopReason: "toolUse" },
			),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("promote the lesson into persona");
	const promoteResults = harness.session.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "memory_promote",
	);
	// First attempt: honest conflict naming the target version to acknowledge.
	expect(promoteResults[0]!.isError).toBe(true);
	expect(getMessageText(promoteResults[0]!)).toContain("target_version=1");
	// Nothing moved yet — the retry is what merges.
	expect(promoteResults[1]!.isError).toBe(false);
	const channel = getMemoryChannel();
	expect(channel.store({ scope: "persona" }).list(true)[0]!.body).toBe("draft summary");
	expect(channel.store({ scope: "scratch" }).list(true)).toHaveLength(0);
});

test("memory_recall searches persona, project, and scratch with scratch provenance", async () => {
	const harness = await setup();
	harness.setResponses([
		writeCall({ type: "profile", title: "orbits preference", body: "likes elliptical orbits", scope: "persona" }),
		writeCall({ type: "procedure", title: "orbits deploy", body: "deploy from the orbits repo", scope: "project" }),
		writeCall({
			type: "anchor",
			title: "orbits scratchpad",
			body: "orbits cluster is in eu-central",
			scope: "scratch",
		}),
		fauxAssistantMessage(fauxToolCall("memory_recall", { query: "orbits" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("what do we know about orbits");
	const recall = getToolResult(harness, "memory_recall");
	expect(recall.isError).toBe(false);
	const text = getMessageText(recall);
	expect(text).toContain("orbits preference");
	expect(text).toContain("orbits deploy");
	expect(text).toContain("orbits scratchpad");
	// Scratch results surface origin and target metadata so the model can
	// propose promotion instead of duplicating the fact.
	expect(text).toContain(harness.sessionManager.getSessionId());
	expect(text).toContain(harness.tempDir);
	expect(text).toContain("memory_promote");
});
