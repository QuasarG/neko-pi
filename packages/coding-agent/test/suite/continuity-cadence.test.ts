import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ActivityStore } from "../../src/core/activity.ts";
import { CONTINUITY_SUMMARY_BUDGET } from "../../src/core/memory/budget.ts";
import {
	CONTINUITY_REMINDER_INTERVAL,
	CONTINUITY_RULE_SECTION,
	continuityQueryCount,
	continuityReminderDue,
	memoryHintFor,
} from "../../src/core/memory/cadence.ts";
import { ContinuityStore } from "../../src/core/memory/continuity.ts";
import { resolveProjectIdentity, scopeKey } from "../../src/core/runtime/identity.ts";
import { getRuntimeState } from "../../src/core/runtime/state-db.ts";
import { type SessionEntry, SessionManager, type SessionMessageEntry } from "../../src/core/session-manager.ts";
import { truncateNativeSession } from "../../src/core/session-truncate.ts";
import memoryExtension from "../../src/extensions/memory/index.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

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

const update = (summary: string, scope: "persona" | "project" = "project") =>
	fauxAssistantMessage(fauxToolCall("continuity_update", { summary, scope }), { stopReason: "toolUse" });

/** Body of the last turn's <checkpoint> block, empty when none was appended. */
const lastCheckpoint = (harness: Harness): string =>
	getUserTexts(harness)
		.at(-1)
		?.match(/<checkpoint>\n([\s\S]*?)\n<\/checkpoint>/)?.[1] ?? "";

/** Project scope of the harness session's own working directory. */
const projectScopeOf = (harness: Harness) => {
	const projectId = resolveProjectIdentity(harness.tempDir).projectId;
	return { scope: "project" as const, projectId };
};

test("the continuity rule states the byte budget, so a summary fits in one attempt", () => {
	expect(CONTINUITY_RULE_SECTION).toContain(String(CONTINUITY_SUMMARY_BUDGET));
});

test("continuity is semantic with a non-owing tenth-query reminder", async () => {
	expect(CONTINUITY_REMINDER_INTERVAL).toBe(10);
	const harness = await setup();
	const manager = harness.sessionManager;
	for (let index = 1; index <= 9; index++) {
		harness.setResponses([fauxAssistantMessage(`a${index}`)]);
		await harness.session.prompt(`q${index}`);
		expect(continuityReminderDue(manager)).toBe(index === 9);
	}
	// The tenth query carries the reminder but skips the write: the turn
	// settles normally and nothing stays owed.
	harness.setResponses([fauxAssistantMessage("a10 skipped")]);
	await harness.session.prompt("q10");
	expect(getUserTexts(harness).at(-1)).toContain("<checkpoint>");
	expect(lastCheckpoint(harness)).toContain("continuity");
	expect(continuityReminderDue(manager)).toBe(false); // the reminder was for the tenth query only
	expect(continuityQueryCount(manager)).toBe(10);
	// The eleventh query repeats no reminder — only the memory floor may
	// still be owed there — and an omitted-scope write lands in the project.
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("continuity_update", { summary: "Work stage." }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("q11");
	expect(lastCheckpoint(harness)).not.toContain("continuity");
	expect(new ContinuityStore(getRuntimeState(), projectScopeOf(harness)).read()?.summary).toBe("Work stage.");
	expect(new ContinuityStore(getRuntimeState()).read()?.summary).not.toBe("Work stage.");
});

test("imperative memory cues hint but recall questions do not", () => {
	expect(memoryHintFor("记住这个服务器路径")).toContain("consider");
	expect(memoryHintFor("remember this preference")).toContain("consider");
	expect(memoryHintFor("别忘了下次先跑测试")).toContain("consider");
	expect(memoryHintFor("keep this in mind from now on")).toContain("consider");
	expect(memoryHintFor("你还记得吗")).toBeUndefined();
	expect(memoryHintFor("do you remember the plan")).toBeUndefined();
	expect(memoryHintFor("只是随便聊聊")).toBeUndefined();
});

test("an imperative cue appends a memory_hint block; a recall question does not", async () => {
	const harness = await setup();
	harness.setResponses([fauxAssistantMessage("记下了。")]);
	await harness.session.prompt("记住这个服务器路径");
	expect(getUserTexts(harness).at(-1)).toContain("<memory_hint>");
	harness.setResponses([fauxAssistantMessage("记得哟。")]);
	await harness.session.prompt("你还记得吗");
	expect(getUserTexts(harness).at(-1)).not.toContain("<memory_hint>");
});

test("the reminder ledger survives restart, is session-scoped, and carries no debt", async () => {
	const manager = SessionManager.create(root, join(root, "sessions"));
	const first = await setup(manager);
	for (const text of ["one", "two"]) {
		first.setResponses([fauxAssistantMessage("answer")]);
		await first.session.prompt(text);
	}
	const second = await setup(SessionManager.open(manager.getSessionFile()!));
	second.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "request rejected" })]);
	await second.session.prompt("three");
	expect(continuityQueryCount(second.sessionManager)).toBe(3);
	expect(continuityReminderDue(second.sessionManager)).toBe(false);
	const other = await setup();
	other.setResponses([fauxAssistantMessage("unrelated answer")]);
	await other.session.prompt("other session one");
	expect(continuityQueryCount(other.sessionManager)).toBe(1);
	for (let index = 4; index <= 9; index++) {
		second.setResponses([fauxAssistantMessage(`a${index}`)]);
		await second.session.prompt(`q${index}`);
	}
	expect(continuityReminderDue(second.sessionManager)).toBe(true);
	// Skipping the tenth-query reminder owes nothing: no flag replays on the
	// following queries, and the next reminder is the twentieth, not sooner.
	second.setResponses([fauxAssistantMessage("a10 skipped")]);
	await second.session.prompt("q10");
	expect(continuityReminderDue(second.sessionManager)).toBe(false);
	second.setResponses([fauxAssistantMessage("a11")]);
	await second.session.prompt("q11");
	expect(continuityReminderDue(second.sessionManager)).toBe(false);
});

test("internal prompts do not advance the ledger, and same receipt retries count once", async () => {
	const harness = await setup();
	harness.setResponses([
		fauxAssistantMessage("answer"),
		fauxAssistantMessage("internal answer"),
		fauxAssistantMessage("retry answer"),
	]);
	await harness.session.prompt("one", { received: { time: 1, messageId: "same-query" } });
	await harness.session.prompt("internal", { source: "extension" });
	await harness.session.prompt("one", { received: { time: 1, messageId: "same-query" } });
	expect(continuityQueryCount(harness.sessionManager)).toBe(1);
});

test("a new fork counts its own queries and truncation removes the discarded saved entry", async () => {
	const manager = SessionManager.create(root, join(root, "sessions"));
	const harness = await setup(manager);
	for (const text of ["one", "two"]) {
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt(text);
	}
	const fork = SessionManager.forkFrom(manager.getSessionFile()!, root, join(root, "forks"));
	expect(continuityQueryCount(fork)).toBe(0);
	const other = await setup(fork);
	other.setResponses([fauxAssistantMessage("fork answer")]);
	await other.session.prompt("fork one");
	expect(continuityQueryCount(other.sessionManager)).toBe(1);
	harness.setResponses([update("Third query stage."), fauxAssistantMessage("done")]);
	await harness.session.prompt("three");
	const saved = manager
		.getBranch()
		.filter(
			(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
				entry.type === "custom" && entry.customType === "continuity.persona.saved",
		);
	expect(saved).toHaveLength(1);
	expect(saved[0]!.data).toMatchObject({ scope: "project" });
	const target = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user")!;
	await truncateNativeSession(harness.session, target.id);
	expect(continuityQueryCount(manager)).toBe(2);
	expect(
		manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "continuity.persona.saved"),
	).toBe(false);
});

test("truncation advances the activity cursor so deleted messages do not replay as unseen", async () => {
	const manager = SessionManager.create(root, join(root, "sessions"));
	const harness = await setup(manager);

	// First send: the query enters the activity log.
	harness.setResponses([fauxAssistantMessage("answer")]);
	await harness.session.prompt("first message that will be deleted");
	const firstUser = manager
		.getBranch()
		.findLast((e) => e.type === "message" && (e as { message: { role: string } }).message.role === "user") as {
		id: string;
	};
	// The test harness only loads the memory extension, so simulate the
	// runtime-context extension's user_query append here.
	const activity = new ActivityStore();
	activity.append("user_query", manager.getSessionId(), null, "first message that will be deleted", {
		scope: "persona",
	});
	const seqBefore = getRuntimeState().lastActivitySeq();
	expect(seqBefore).toBeGreaterThan(0);

	// /edit removes the turn — the activity cursor must skip past the deleted
	// query, not leave it "unseen" for replay.
	await truncateNativeSession(harness.session, firstUser.id);

	// The cursor should now be at or past the deleted query's seq.
	// receiptKey is scopeKey({scope:"project", projectId}), matching how
	// ActivityStore.prepare() and advanceCursorAfterTruncation mark it.
	const receiptAfter = getRuntimeState().getReceipt(
		manager.getSessionId(),
		"activity",
		scopeKey({ scope: "project", projectId: resolveProjectIdentity(root).projectId }),
	);
	expect(receiptAfter?.version).toBeGreaterThanOrEqual(seqBefore);

	// A genuinely new event after the truncation is still deliverable.
	const other = new ActivityStore();
	other.append("memory_updated", "other-session", null, "external fact", { scope: "persona" });
	const seqAfter = getRuntimeState().lastActivitySeq();
	expect(seqAfter).toBeGreaterThan(receiptAfter?.version ?? 0);
});

test("truncation drops delivery receipts so an edited-and-resent message re-receives injections", async () => {
	const isUserEntry = (entry: SessionEntry): entry is SessionMessageEntry =>
		entry.type === "message" && entry.message.role === "user";
	const manager = SessionManager.create(root, join(root, "sessions"));
	const harness = await setup(manager);
	const store = new ContinuityStore(getRuntimeState());
	const revision = store.claim("seed");
	expect(store.commit(revision, "Campfire stage.")).toBe(true);

	// First send: the continuity note is delivered with the user message.
	harness.setResponses([fauxAssistantMessage("answer")]);
	await harness.session.prompt("first");
	const firstUser = manager.getBranch().findLast(isUserEntry)!;
	expect(JSON.stringify((firstUser.message as { content: unknown }).content)).toContain("Recent shared continuity");

	// /edit removes the turn — its injected text is gone, and the delivery
	// receipts that survived the truncation must not suppress the resend.
	await truncateNativeSession(harness.session, firstUser.id);

	harness.setResponses([fauxAssistantMessage("resend")]);
	await harness.session.prompt("first");
	const resent = manager.getBranch().findLast(isUserEntry)!;
	expect(JSON.stringify((resent.message as { content: unknown }).content)).toContain("Recent shared continuity");
});

test("a stale persona write is rejected until an explicit merge against the current version succeeds", async () => {
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
			return update("Stale stage.", "persona");
		},
		() =>
			fauxAssistantMessage(
				fauxToolCall("continuity_update", {
					summary: "Other session stage; current discussion continues.",
					expected_version: store.read()!.version,
					scope: "persona",
				}),
				{ stopReason: "toolUse" },
			),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("three");
	const results = harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map(getMessageText)
		.join("\n");
	expect(results).toContain("Not saved: a newer session is active");
	expect(results).toContain("Continuity updated.");
	expect(new ContinuityStore(getRuntimeState()).read()?.summary).toBe(
		"Other session stage; current discussion continues.",
	);
});
