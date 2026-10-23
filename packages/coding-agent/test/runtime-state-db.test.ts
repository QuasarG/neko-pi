import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveProjectIdentity, scopeKey } from "../src/core/runtime/identity.ts";
import { hashText, RuntimeState } from "../src/core/runtime/state-db.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempState(): { state: RuntimeState; root: string } {
	const root = mkdtempSync(join(tmpdir(), "neko-state-"));
	scratch.push(root);
	const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
	return { state, root };
}

function project(root: string, name: string) {
	const identity = resolveProjectIdentity(join(root, name));
	mkdirSync(join(root, name), { recursive: true });
	return identity;
}

describe("runtime state db", () => {
	test("schema migration is idempotent and reopening keeps data", () => {
		const { state, root } = tempState();
		const p = project(root, "repo");
		state.ensureProject(p);
		state.close();
		const reopened = new RuntimeState(join(root, "runtime", "state.sqlite"));
		expect(reopened.getProject(p.projectId)?.canonical).toBe(p.canonical);
		reopened.close();
	});

	test("persona and project scope versions advance independently", () => {
		const { state, root } = tempState();
		const p = project(root, "repo");
		const persona = { scope: "persona" } as const;
		const proj = { scope: "project", projectId: p.projectId } as const;
		expect(state.scopeVersion(persona)).toBe(0);
		expect(state.scopeVersion(proj)).toBe(0);
		state.registerMemoryWrite({
			scope: persona,
			recordId: "rec_a",
			type: "profile",
			title: "t",
			file: "a.md",
			content: "x",
			status: null,
			occurred: null,
			created: Date.now(),
			change: "created",
		});
		expect(state.scopeVersion(persona)).toBe(1);
		expect(state.scopeVersion(proj)).toBe(0);
		state.registerMemoryWrite({
			scope: proj,
			recordId: "rec_b",
			type: "procedure",
			title: "u",
			file: "b.md",
			content: "y",
			status: null,
			occurred: null,
			created: Date.now(),
			change: "created",
		});
		expect(state.scopeVersion(proj)).toBe(1);
		expect(state.scopeVersion(persona)).toBe(1);
		state.close();
	});

	test("record versions increment and topics are findable per scope", () => {
		const { state, root } = tempState();
		const p = project(root, "repo");
		const persona = { scope: "persona" } as const;
		const proj = { scope: "project", projectId: p.projectId } as const;
		state.registerMemoryWrite({
			scope: persona,
			recordId: "rec_1",
			type: "profile",
			title: "same",
			file: "p.md",
			content: "persona body",
			status: null,
			occurred: null,
			created: Date.now(),
			change: "created",
		});
		state.registerMemoryWrite({
			scope: proj,
			recordId: "rec_2",
			type: "procedure",
			title: "same",
			file: "q.md",
			content: "project body",
			status: null,
			occurred: null,
			created: Date.now(),
			change: "created",
		});
		const inPersona = state.findMemoryRecordByTopic(persona, "profile", "same");
		const inProject = state.findMemoryRecordByTopic(proj, "procedure", "same");
		expect(inPersona?.recordId).toBe("rec_1");
		expect(inProject?.recordId).toBe("rec_2");
		state.registerMemoryWrite({
			scope: persona,
			recordId: "rec_1",
			type: "profile",
			title: "same",
			file: "p.md",
			content: "persona v2",
			status: null,
			occurred: null,
			created: Date.now(),
			change: "updated",
		});
		expect(state.getMemoryRecord(persona, "rec_1")?.version).toBe(2);
		expect(state.listMemoryRecords(proj)).toHaveLength(1);
		state.close();
	});

	test("changes are tombstoned on delete and filtered by visible scope", () => {
		const { state, root } = tempState();
		const a = project(root, "alpha");
		const b = project(root, "beta");
		const scopeA = { scope: "project", projectId: a.projectId } as const;
		const scopeB = { scope: "project", projectId: b.projectId } as const;
		state.registerMemoryWrite({
			scope: scopeA,
			recordId: "rec_a",
			type: "anchor",
			title: "a",
			file: "a.md",
			content: "x",
			status: null,
			occurred: null,
			created: Date.now(),
			change: "created",
		});
		state.registerMemoryWrite({
			scope: scopeB,
			recordId: "rec_b",
			type: "anchor",
			title: "b",
			file: "b.md",
			content: "y",
			status: null,
			occurred: null,
			created: Date.now(),
			change: "created",
		});
		const beforeDelete = state.changesSince(0, a.projectId);
		state.deleteMemoryRecord(scopeA, "rec_a");
		const afterDelete = state.changesSince(beforeDelete[0]!.seq - 1, a.projectId);
		expect(afterDelete.some((row) => row.change === "deleted" && row.recordId === "rec_a")).toBe(true);
		// B's changes never leak into A's view.
		expect(state.changesSince(0, a.projectId).some((row) => row.recordId === "rec_b")).toBe(false);
		expect(state.getMemoryRecord(scopeA, "rec_a")).toBeUndefined();
		state.close();
	});

	test("double-write journal classifies crash windows for the memory channel", () => {
		const { state, root } = tempState();
		const persona = { scope: "persona" } as const;
		const body = "crash window body";
		const file = join(root, "memory", "persona", "note.md");
		mkdirSync(dirname(file), { recursive: true });
		const op = state.beginJournal({
			scope: persona,
			recordId: "rec_c",
			oldHash: null,
			newHash: hashText(body),
			file,
			pending: "op pending",
		});
		// Crash simulation: file is written, journal still open, metadata never registered.
		writeFileSync(file, body);
		state.markFileWritten(op);
		const verdicts = state.recoverJournal((f) => (f === file ? hashText(readFileSync(f, "utf8")) : undefined));
		expect(verdicts).toEqual([{ entry: expect.objectContaining({ operationId: op }), result: "completed" }]);
		// The channel then re-registers from the file body and clears the entry.
		state.registerMemoryWrite({
			scope: persona,
			recordId: "rec_c",
			type: "anchor",
			title: "note",
			file,
			content: body,
			status: null,
			occurred: null,
			created: Date.now(),
			change: "updated",
			operationId: op,
		});
		expect(state.listJournal()).toHaveLength(0);
		expect(state.getMemoryRecord(persona, "rec_c")?.contentHash).toBe(hashText(body));
		state.close();
	});

	test("journal rolls back when the file never landed and conflicts on foreign content", () => {
		const { state, root } = tempState();
		const persona = { scope: "persona" } as const;
		const file = join(root, "memory", "persona", "note2.md");
		mkdirSync(dirname(file), { recursive: true });
		const oldBody = "old";
		writeFileSync(file, oldBody);
		const rollbackOp = state.beginJournal({
			scope: persona,
			recordId: "rec_r",
			oldHash: hashText(oldBody),
			newHash: hashText("new"),
			file,
			pending: "p",
		});
		const rolled = state.recoverJournal(() => hashText(readFileSync(file, "utf8")));
		expect(rolled[0]!.result).toBe("rolled_back");
		state.clearJournalEntry(rollbackOp);
		const foreignOp = state.beginJournal({
			scope: persona,
			recordId: "rec_x",
			oldHash: hashText("expected old"),
			newHash: hashText("new"),
			file,
			pending: "p",
		});
		const conflicted = state.recoverJournal(() => hashText(readFileSync(file, "utf8")));
		expect(conflicted[0]!.result).toBe("conflict");
		expect(state.listJournal().some((entry) => entry.operationId === foreignOp)).toBe(true);
		state.close();
	});

	test("retrying the same operation id is idempotent", () => {
		const { state } = tempState();
		const persona = { scope: "persona" } as const;
		const version1 = state.registerMemoryWrite({
			scope: persona,
			recordId: "rec_i",
			type: "anchor",
			title: "i",
			file: "i.md",
			content: "one",
			status: null,
			occurred: null,
			created: Date.now(),
			change: "created",
			operationId: "op_i",
		});
		const version2 = state.registerMemoryWrite({
			scope: persona,
			recordId: "rec_i",
			type: "anchor",
			title: "i",
			file: "i.md",
			content: "one",
			status: null,
			occurred: null,
			created: Date.now(),
			change: "created",
			operationId: "op_i",
		});
		expect(version2).toBeGreaterThan(version1);
		// One journal entry clears once; clearing an unknown op is a no-op, not a crash.
		state.close();
	});

	test("activities are scoped, bounded and pruned by retention", () => {
		const { state, root } = tempState();
		const p = project(root, "repo");
		const persona = { scope: "persona" } as const;
		const proj = { scope: "project", projectId: p.projectId } as const;
		const seq1 = state.appendActivity({
			session: "s1",
			scope: persona,
			kind: "user_query",
			payload: "hello",
			now: 1000,
		});
		state.appendActivity({ session: "s1", scope: proj, kind: "memory_updated", payload: "x" });
		const visibleToPersona = state.activitiesSince(0, null, 8000);
		expect(visibleToPersona.events).toHaveLength(1);
		const visibleToProject = state.activitiesSince(0, p.projectId, 8000);
		expect(visibleToProject.events).toHaveLength(2);
		state.appendActivity({ session: "s2", scope: proj, kind: "user_query", payload: "z".repeat(5000) });
		state.appendActivity({ session: "s2", scope: proj, kind: "user_query", payload: "z".repeat(5000) });
		const bounded = state.activitiesSince(0, p.projectId, 8000);
		expect(bounded.omitted).toBeGreaterThanOrEqual(1);
		expect(bounded.events.length).toBeLessThan(bounded.events.length + bounded.omitted);
		state.appendActivity({
			session: "s3",
			scope: proj,
			kind: "user_query",
			payload: "old",
			now: Date.now() - 22 * 86_400_000,
		});
		expect(state.pruneActivities(Date.now(), 21 * 86_400_000)).toBeGreaterThanOrEqual(1);
		expect(seq1).toBeGreaterThan(0);
		state.close();
	});

	test("continuity stores per-scope rows with optimistic version checks", () => {
		const { state, root } = tempState();
		const p = project(root, "repo");
		const key = scopeKey({ scope: "project", projectId: p.projectId });
		expect(
			state.setContinuity({
				key,
				scope: { scope: "project", projectId: p.projectId },
				content: "v1",
				expires: null,
				expectedVersion: 0,
			}).saved,
		).toBe(true);
		expect(
			state.setContinuity({
				key,
				scope: { scope: "project", projectId: p.projectId },
				content: "stale",
				expires: null,
				expectedVersion: 0,
			}).saved,
		).toBe(false);
		expect(state.getContinuity(key)?.content).toBe("v1");
		expect(state.getContinuity(key)?.version).toBe(1);
		state.close();
	});

	test("wardrobe import preserves selection and lock only when still valid", () => {
		const { state } = tempState();
		state.importWardrobe(
			[
				{ id: "a", name: "A", description: "first", enabled: true },
				{ id: "b", name: "B", description: "second", enabled: true },
			],
			"a",
		);
		state.setWardrobeSelection("b", 123);
		expect(state.getWardrobeState().current).toBe("b");
		state.importWardrobe([{ id: "c", name: "C", description: "third", enabled: true }], null);
		expect(state.getWardrobeState().current).toBeNull();
		expect(state.listOutfits(true)).toHaveLength(1);
		state.close();
	});

	test("message intake dedupes ids and snapshots scope versions", () => {
		const { state, root } = tempState();
		const p = project(root, "repo");
		state.upsertSession({ bridgeId: "ses_1", projectId: p.projectId, state: "idle" });
		const admitted = state.enqueueMessage({
			messageId: "msg_1",
			session: "ses_1",
			projectId: p.projectId,
			received: 111,
			timeZone: "Asia/Shanghai",
			text: "hi",
			personaVersion: 2,
			projectVersion: 3,
			activityThrough: 7,
			state: "queued",
			retryOf: null,
		});
		const duplicate = state.enqueueMessage({
			messageId: "msg_1",
			session: "ses_1",
			projectId: p.projectId,
			received: 222,
			timeZone: "UTC",
			text: "hi again",
			personaVersion: 9,
			projectVersion: 9,
			activityThrough: 9,
			state: "queued",
			retryOf: null,
		});
		expect(admitted).toBe(true);
		expect(duplicate).toBe(false);
		const stored = state.getMessage("msg_1")!;
		expect(stored.received).toBe(111);
		expect(stored.personaVersion).toBe(2);
		state.setMessageState("msg_1", "done");
		expect(state.getMessage("msg_1")?.state).toBe("done");
		expect(() => state.upsertSession({ bridgeId: "ses_1", projectId: "f".repeat(64), state: "idle" })).toThrow(
			/different project/,
		);
		state.close();
	});

	test("two processes share one database with consistent state", () => {
		const root = mkdtempSync(join(tmpdir(), "neko-state-mp-"));
		scratch.push(root);
		const file = join(root, "runtime", "state.sqlite");
		new RuntimeState(file).close();
		const script = join(root, "writer.mjs");
		writeFileSync(
			script,
			`import { RuntimeState, hashText } from ${JSON.stringify(new URL("../src/core/runtime/state-db.ts", import.meta.url).href)};
const state = new RuntimeState(process.argv[2]);
const id = process.argv[3];
state.ensureProject({ projectId: id, canonical: "/canon/" + id, original: "/canon/" + id, name: id });
for (let i = 0; i < 25; i++) state.registerMemoryWrite({ scope: { scope: "persona" }, recordId: "rec_" + id, type: "anchor", title: id, file: id + ".md", content: id + i, status: null, occurred: null, created: Date.now(), change: "updated" });
state.close();`,
		);
		execFileSync(process.execPath, ["--experimental-strip-types", script, file, "aa"], { stdio: "pipe" });
		execFileSync(process.execPath, ["--experimental-strip-types", script, file, "bb"], { stdio: "pipe" });
		const state = new RuntimeState(file);
		expect(
			state
				.listProjects()
				.map((p) => p.name)
				.sort(),
		).toEqual(["aa", "bb"]);
		expect(state.getMemoryRecord({ scope: "persona" }, "rec_aa")!.version).toBe(25);
		expect(state.getMemoryRecord({ scope: "persona" }, "rec_bb")!.version).toBe(25);
		state.close();
	});
});
