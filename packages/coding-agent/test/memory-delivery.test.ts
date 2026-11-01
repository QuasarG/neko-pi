import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryChannel } from "../src/core/memory/channel.ts";
import {
	buildMemoryDelivery,
	type MemoryDelivery,
	pendingDeliveryScopes,
	recordFingerprint,
	recordReceiptRef,
	recordStablePayload,
	visibleMemoryRecords,
} from "../src/core/memory/delivery.ts";
import { diffMemoryBodies, lineDiffRegions } from "../src/core/memory/diff.ts";
import { type MemoryScope, resolveProjectIdentity, scopeKey } from "../src/core/runtime/identity.ts";
import { RuntimeState } from "../src/core/runtime/state-db.ts";

const scratchDirs: string[] = [];
afterEach(() => {
	for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "neko-delivery-"));
	scratchDirs.push(root);
	const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
	const channel = new MemoryChannel(join(root, "memory"), state);
	return { root, state, channel };
}

/** Mirror the extension's turn queue: receipts and diff-cache entries commit together. */
function commitDelivery(session: string, state: RuntimeState, delivery: MemoryDelivery): void {
	for (const receipt of delivery.receipts)
		state.markReceipt(session, "memory_record", receipt.fingerprint, receipt.ref);
	for (const snapshot of delivery.snapshots)
		state.upsertMemorySnapshot(session, snapshot.ref, snapshot.version, snapshot.body);
}

/** Project scope for a fresh directory under the test root. */
function projectScopeOf(root: string, name: string) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const identity = resolveProjectIdentity(dir);
	return { scope: "project" as const, projectId: identity.projectId };
}

describe("per-record memory delivery", () => {
	test("baseline delivers every visible record once, then only a changed record", () => {
		const { root, state, channel } = setup();
		channel.write({ type: "anchor", title: "one", body: "one body", source: "model", scope: { scope: "persona" } });
		// Multi-line body: a one-line edit stays under the diff-economy guard
		// (a diff past half the new body falls back to the full body).
		channel.write({
			type: "anchor",
			title: "two",
			body: "two body\nsecond line\nthird line\nfourth line\nfifth line\nsixth line",
			source: "model",
			scope: { scope: "persona" },
		});
		const projectScope = projectScopeOf(root, "repo");
		const first = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(first.sections.join("\n")).toContain("### Memory baseline: persona");
		expect(first.sections.join("\n")).toContain("one body");
		expect(first.sections.join("\n")).toContain("two body");
		// Record metadata carries the exact spellings the frontend parser reads:
		// title, type with version and bytes, and the absolute file path.
		expect(first.sections[0]).toContain("- record: ");
		expect(first.sections[0]).toContain("- type: anchor · version: 1 · bytes: ");
		expect(first.sections[0]).toContain(`- file: ${join(root, "memory", "persona")}`);
		expect(first.receipts).toHaveLength(2);
		commitDelivery("s1", state, first);

		const unchanged = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(unchanged.sections).toHaveLength(0);
		expect(unchanged.receipts).toHaveLength(0);
		expect(unchanged.tombstones).toHaveLength(0);

		channel.write({
			type: "anchor",
			title: "two",
			body: "two body v2\nsecond line\nthird line\nfourth line\nfifth line\nsixth line",
			source: "model",
			scope: { scope: "persona" },
		});
		const updated = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(updated.sections).toHaveLength(1);
		expect(updated.sections[0]).toContain("### Memory update: persona");
		// A delivered snapshot turns the resend into a line diff, not a full body.
		expect(updated.sections[0]).toContain("- update: diff against delivered v1");
		expect(updated.sections[0]).toContain("- two body");
		expect(updated.sections[0]).toContain("+ two body v2");
		expect(updated.sections[0]).not.toContain("one body");
		commitDelivery("s1", state, updated);
		// The diff bytes count against the budget, so the update went through.
		expect(updated.omitted).toHaveLength(0);
	});

	test("removed records produce a withdrawal and project records stay invisible elsewhere", async () => {
		const { root, state, channel } = setup();
		const projectScope = projectScopeOf(root, "repo");
		channel.write({
			type: "anchor",
			title: "personal",
			body: "persona body",
			source: "model",
			scope: { scope: "persona" },
		});
		channel.write({ type: "procedure", title: "work", body: "project body", source: "model", scope: projectScope });
		const first = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(first.sections.join("\n")).toContain("persona body");
		expect(first.sections.join("\n")).toContain("project body");
		for (const receipt of first.receipts) state.markReceipt("s1", "memory_record", receipt.fingerprint, receipt.ref);

		// Delete the persona record the way an external editor would; the sync
		// registers the loss and the next delivery withdraws the record.
		const personaStore = channel.store({ scope: "persona" });
		const file = personaStore.list(true).find((record) => record.title === "personal")!.file!;
		rmSync(join(personaStore.dir, file));
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		channel.syncExternalChanges({ scope: "persona" });
		const after = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(after.tombstones).toHaveLength(1);
		expect(after.tombstones[0]!.scopeKey).toBe("persona");
		expect(after.tombstones[0]!.recordId).toMatch(/^rec_/);
		expect(after.sections.join("\n")).toContain("### Memory removed: persona");
		expect(after.sections.join("\n")).toContain("- record_id: ");
		expect(after.sections.join("\n")).toContain(
			"A previously delivered record no longer exists; discard its earlier content.",
		);

		// The same session from another cwd never saw the first project's
		// records: no baseline for them, and their receipts are ignored, not
		// mistaken for removals.
		const elsewhere = projectScopeOf(root, "other");
		const moved = buildMemoryDelivery({ sessionId: "s1", projectScope: elsewhere, channel });
		expect(moved.sections.join("\n")).not.toContain("project body");
		expect(moved.receipts.map((receipt) => receipt.ref).some((ref) => ref.startsWith("project:"))).toBe(false);
		expect(moved.tombstones.some((tombstone) => tombstone.scopeKey === scopeKey(projectScope))).toBe(false);
	});

	test("scratch records are visible only to their origin session", () => {
		const { root, channel } = setup();
		const projectScope = projectScopeOf(root, "repo");
		channel.write({
			type: "anchor",
			title: "parked fact",
			body: "scratch body",
			source: "model",
			scope: { scope: "scratch" },
			originSessionId: "origin",
			originCwd: "/cwd",
		});
		expect(visibleMemoryRecords({ sessionId: "origin", projectScope, channel }).map((r) => r.title)).toEqual([
			"parked fact",
		]);
		expect(visibleMemoryRecords({ sessionId: "other", projectScope, channel })).toHaveLength(0);
		const origin = buildMemoryDelivery({ sessionId: "origin", projectScope, channel });
		expect(origin.sections.join("\n")).toContain("### Memory baseline: scratch");
		expect(origin.sections.join("\n")).toContain("scratch body");
		const other = buildMemoryDelivery({ sessionId: "other", projectScope, channel });
		expect(other.sections).toHaveLength(0);
	});

	test("delivers six persona books that together exceed the retired 16 KiB cap", () => {
		const { root, channel } = setup();
		const projectScope = projectScopeOf(root, "repo");
		// The real six-book ledger is ~18 KiB; a delivery budget smaller than
		// the active ceiling used to omit one book on every single query.
		for (let index = 0; index < 6; index++) {
			channel.write({
				type: "anchor",
				title: `book ${index}`,
				body: `${index}`.repeat(3 * 1024),
				source: "model",
				scope: { scope: "persona" },
			});
		}
		const delivery = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(delivery.omitted).toHaveLength(0);
		expect(delivery.receipts).toHaveLength(6);
		expect(delivery.sections).toHaveLength(6);
		for (let index = 0; index < 6; index++) {
			expect(delivery.sections.join("\n")).toContain(`- record: book ${index}`);
		}
	});

	test("delivery budget lists omitted records instead of truncating bodies", async () => {
		const { root, state, channel } = setup();
		const projectScope = projectScopeOf(root, "repo");
		// Records are capped at 16 KiB on write, so an over-budget scope only
		// arises from an external hand edit: grow the files on disk directly,
		// exactly the path syncExternalChanges exists for.
		const persona = channel.store({ scope: "persona" });
		const oldBig = persona.write({ type: "anchor", title: "old big", body: "x".repeat(15 * 1024), source: "model" });
		// Distinct timestamps keep the newest-first order deterministic.
		await new Promise((resolve) => setTimeout(resolve, 5));
		const newBig = persona.write({ type: "anchor", title: "new big", body: "x".repeat(15 * 1024), source: "model" });
		for (const written of [oldBig, newBig]) {
			appendFileSync(join(persona.dir, written.file), `${"x".repeat(25 * 1024)}END-OF-BODY`);
		}
		const first = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		// Only the newest fits the 64 KiB persona budget; it arrives whole.
		expect(first.sections[0]).toContain("- record: new big");
		expect(first.sections[0]).toContain("END-OF-BODY");
		expect(Buffer.byteLength(first.sections[0]!)).toBeGreaterThan(40 * 1024);
		expect(first.sections[0]).not.toContain("- record: old big");
		// The omitted record is named with its file, never silently truncated.
		expect(first.omitted).toHaveLength(1);
		expect(first.omitted[0]!.scope).toEqual({ scope: "persona" } satisfies MemoryScope);
		expect(first.omitted[0]!.title).toBe("old big");
		expect(first.omitted[0]!.file).toContain(join(root, "memory", "persona"));
		expect(first.sections.join("\n")).toContain("more records exceeded");
		// Only the delivered record earned a receipt; the omitted one stays
		// pending, not silently dropped: the next query has free budget and
		// delivers it whole, after which the delivery goes quiet.
		expect(first.receipts).toHaveLength(1);
		for (const receipt of first.receipts) state.markReceipt("s1", "memory_record", receipt.fingerprint, receipt.ref);
		const second = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(second.sections).toHaveLength(1);
		expect(second.sections[0]).toContain("- record: old big");
		for (const receipt of second.receipts) state.markReceipt("s1", "memory_record", receipt.fingerprint, receipt.ref);
		const again = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(again.sections).toHaveLength(0);
	});

	test("a sole record over the project budget is omitted with a notice, never silently dropped", () => {
		const { root, channel } = setup();
		const projectScope = projectScopeOf(root, "repo");
		const store = channel.store(projectScope);
		const written = store.write({
			type: "anchor",
			title: "huge project fact",
			body: "y".repeat(15 * 1024),
			source: "model",
		});
		appendFileSync(join(store.dir, written.file), "y".repeat(20 * 1024));
		// Nothing else is deliverable in this scope: the omission notice must
		// stand alone instead of the record vanishing without a word.
		const delivery = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(delivery.sections).toHaveLength(1);
		expect(delivery.sections[0]).toContain("1 more records exceeded the 32768-byte project");
		expect(delivery.sections[0]).toContain("huge project fact");
		expect(delivery.sections[0]).toContain(join(root, "memory", "projects"));
		expect(delivery.omitted).toHaveLength(1);
		expect(delivery.omitted[0]!.title).toBe("huge project fact");
		expect(delivery.receipts).toHaveLength(0);
		// The record earns no receipt, so every later query repeats the honest
		// notice until the record shrinks or is read another way.
		const repeat = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(repeat.sections.join("\n")).toContain("more records exceeded");
	});

	test("a no-op merge does not re-inject, but a real content change does", () => {
		const { root, state, channel } = setup();
		const projectScope = projectScopeOf(root, "repo");
		const keeps = "keep one\nkeep two\nkeep three\nkeep four\nkeep five";
		channel.write({
			type: "anchor",
			title: "stable",
			body: `same body\n${keeps}`,
			source: "model",
			scope: { scope: "persona" },
		});
		const first = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		commitDelivery("s1", state, first);
		// Another session merges the identical content: version and updated
		// bump on disk, but the stable payload — and so the fingerprint —
		// must not, or every merge anywhere would re-inject everywhere.
		channel.write({
			type: "anchor",
			title: "stable",
			body: `same body\n${keeps}`,
			source: "user",
			scope: { scope: "persona" },
		});
		expect(channel.store({ scope: "persona" }).list(true)[0]!.version).toBe(2);
		expect(buildMemoryDelivery({ sessionId: "s1", projectScope, channel }).sections).toHaveLength(0);
		// A body change re-delivers that record as a diff against the copy the
		// session already holds.
		channel.write({
			type: "anchor",
			title: "stable",
			body: `edited body\n${keeps}`,
			source: "user",
			scope: { scope: "persona" },
		});
		const updated = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(updated.sections).toHaveLength(1);
		expect(updated.sections[0]).toContain("### Memory update: persona");
		expect(updated.sections[0]).toContain("- update: diff against delivered v1");
		expect(updated.sections[0]).toContain("- same body");
		expect(updated.sections[0]).toContain("+ edited body");
	});

	test("pendingDeliveryScopes reports per-scope injection state for /context", async () => {
		const { root, state, channel } = setup();
		const projectScope = projectScopeOf(root, "repo");
		channel.write({
			type: "anchor",
			title: "personal",
			body: "persona body",
			source: "model",
			scope: { scope: "persona" },
		});
		channel.write({ type: "procedure", title: "work", body: "project body", source: "model", scope: projectScope });
		// Nothing delivered yet: both visible scopes are pending.
		const before = pendingDeliveryScopes({ sessionId: "s1", projectScope, channel });
		expect(before.has("persona")).toBe(true);
		expect(before.has(scopeKey(projectScope))).toBe(true);
		// Deliver and commit both receipts: nothing is pending anywhere.
		const delivery = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		for (const receipt of delivery.receipts)
			state.markReceipt("s1", "memory_record", receipt.fingerprint, receipt.ref);
		expect(pendingDeliveryScopes({ sessionId: "s1", projectScope, channel }).size).toBe(0);
		// A hand deletion of the persona record leaves a tombstone pending.
		const personaStore = channel.store({ scope: "persona" });
		rmSync(join(personaStore.dir, personaStore.list(true)[0]!.file!));
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		channel.syncExternalChanges({ scope: "persona" });
		const after = pendingDeliveryScopes({ sessionId: "s1", projectScope, channel });
		expect(after.has("persona")).toBe(true);
		expect(after.has(scopeKey(projectScope))).toBe(false);
	});

	test("a shell-damaged record without created: fingerprints stably and delivers once", async () => {
		const { root, state, channel } = setup();
		const projectScope = projectScopeOf(root, "repo");
		// Frontmatter exactly the way a shell rewrite leaves it: no created,
		// no updated, no salience. readRecordFile used to fall back to a fresh
		// new Date() per parse, so every turn re-delivered the record.
		const personaDir = join(root, "memory", "persona");
		mkdirSync(personaDir, { recursive: true });
		writeFileSync(
			join(personaDir, "anchor-damaged--23423170fad3.md"),
			[
				"---",
				"id: rec_23423170fad3",
				"type: anchor",
				"title: 纪念日",
				"version: 22",
				"---",
				"",
				"纪念日 body",
				"",
			].join("\n"),
		);
		// Two force-fresh parses at different wall-clock times must agree.
		const first = recordFingerprint(channel.store({ scope: "persona" }).list(true)[0]!);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(recordFingerprint(channel.store({ scope: "persona" }).list(true)[0]!)).toBe(first);
		// Turn N: the record delivers as a baseline and its receipt is marked.
		const delivery = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(delivery.sections.join("\n")).toContain("### Memory baseline: persona");
		expect(delivery.receipts).toHaveLength(1);
		commitDelivery("s1", state, delivery);
		// Turn N+1, after the clock moved on: the stable fingerprint matches the
		// receipt, so nothing is re-delivered — the loop stays dead.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const again = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(again.sections).toHaveLength(0);
		expect(again.receipts).toHaveLength(0);
		expect(again.tombstones).toHaveLength(0);
	});

	test("recordFingerprint hashes the stable payload and accepts precomputed bytes", () => {
		const { channel } = setup();
		channel.write({
			type: "anchor",
			title: "fingerprint",
			body: "body",
			source: "model",
			scope: { scope: "persona" },
		});
		const record = channel.store({ scope: "persona" }).list(true)[0]!;
		const payload = recordStablePayload(record);
		expect(recordFingerprint(record)).toBe(recordFingerprint(record, payload));
		expect(Number.isInteger(recordFingerprint(record))).toBe(true);
		expect(recordFingerprint(record)).toBeGreaterThan(0);
		expect(recordFingerprint(record)).toBeLessThanOrEqual(0xffffffff);
		// Volatile counters are excluded; content and provenance are not.
		expect(recordStablePayload({ ...record, version: 99, updated: new Date("2020-01-01T00:00:00Z") })).toBe(payload);
		expect(recordStablePayload({ ...record, body: "changed" })).not.toBe(payload);
		expect(recordStablePayload({ ...record, title: "renamed" })).not.toBe(payload);
		expect(recordStablePayload({ ...record, originSessionId: "s9" })).not.toBe(payload);
	});

	test("an updated record without a snapshot falls back to the full body, then diffs again", () => {
		const { root, state, channel } = setup();
		const projectScope = projectScopeOf(root, "repo");
		const keeps = "keep one\nkeep two\nkeep three\nkeep four\nkeep five\nkeep six";
		channel.write({
			type: "anchor",
			title: "migrated",
			body: "old full body",
			source: "model",
			scope: { scope: "persona" },
		});
		const first = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		// Pre-upgrade session: receipts committed, diff cache never populated.
		for (const receipt of first.receipts) state.markReceipt("s1", "memory_record", receipt.fingerprint, receipt.ref);
		channel.write({
			type: "anchor",
			title: "migrated",
			body: `new full body\n${keeps}`,
			source: "model",
			scope: { scope: "persona" },
		});
		const updated = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(updated.sections).toHaveLength(1);
		expect(updated.sections[0]).toContain("### Memory update: persona");
		expect(updated.sections[0]).toContain("- update: full (snapshot unavailable)");
		expect(updated.sections[0]).toContain("new full body");
		// The fallback still refreshes the cache, so the next update diffs.
		commitDelivery("s1", state, updated);
		channel.write({
			type: "anchor",
			title: "migrated",
			body: `newest body\n${keeps}`,
			source: "model",
			scope: { scope: "persona" },
		});
		const next = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(next.sections[0]).toContain("- update: diff against delivered v2");
		expect(next.sections[0]).toContain("- new full body");
		expect(next.sections[0]).toContain("+ newest body");
	});

	test("budget accounting counts the rendered diff, not the full updated body", async () => {
		const { root, state, channel } = setup();
		const projectScope = projectScopeOf(root, "repo");
		const persona = channel.store({ scope: "persona" });
		const big = persona.write({
			type: "anchor",
			title: "big book",
			body: `HEADER\n${"x".repeat(15 * 1024)}`,
			source: "model",
		});
		const _small = persona.write({
			type: "anchor",
			title: "small book",
			body: "s".repeat(15 * 1024),
			source: "model",
		});
		const baseline = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(baseline.omitted).toHaveLength(0);
		commitDelivery("s1", state, baseline);
		// Hand-edit growth: the big record doubles past its write-time size,
		// exactly the external path syncExternalChanges exists for.
		appendFileSync(join(persona.dir, big.file), `\n${"y".repeat(40 * 1024)}`);
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		channel.syncExternalChanges({ scope: "persona" });
		const grown = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(grown.sections).toHaveLength(1);
		// The 40 KiB appended block outweighs half of the ~55 KiB body, so the
		// diff is refused and the full body ships as the honest fallback.
		expect(grown.sections[0]).toContain("- update: full (diff not smaller)");
		expect(grown.sections[0]).toContain("- record: big book");
		commitDelivery("s1", state, grown);
		// Now both records change by one line: the rendered diffs are tiny,
		// while the full bodies (~15 KiB + ~55 KiB) would blow the 64 KiB
		// persona budget and force an omission.
		appendFileSync(join(persona.dir, big.file), "\nzz-tail");
		persona.write({
			type: "anchor",
			title: "small book",
			body: `${"s".repeat(15 * 1024)}\npatched line`,
			source: "user",
		});
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		channel.syncExternalChanges({ scope: "persona" });
		const patched = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(patched.receipts).toHaveLength(2);
		expect(patched.omitted).toHaveLength(0);
		const rendered = patched.sections.reduce((total, section) => total + Buffer.byteLength(section), 0);
		expect(rendered).toBeLessThan(8 * 1024);
		expect(patched.sections.join("\n")).toContain("+ zz-tail");
		expect(patched.sections.join("\n")).toContain("+ patched line");
	});

	test("delivered snapshots are cleared when their tombstone is delivered", async () => {
		const { root, state, channel } = setup();
		const projectScope = projectScopeOf(root, "repo");
		channel.write({
			type: "anchor",
			title: "doomed",
			body: "doomed body",
			source: "model",
			scope: { scope: "persona" },
		});
		const recordId = channel.store({ scope: "persona" }).list(true)[0]!.id!;
		const ref = recordReceiptRef({ scope: "persona" }, recordId);
		commitDelivery("s1", state, buildMemoryDelivery({ sessionId: "s1", projectScope, channel }));
		expect(state.getMemorySnapshot("s1", ref)?.body).toBe("doomed body");
		// Hand deletion; the next delivery withdraws the record.
		const persona = channel.store({ scope: "persona" });
		rmSync(join(persona.dir, persona.list(true)[0]!.file!));
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		channel.syncExternalChanges({ scope: "persona" });
		const after = buildMemoryDelivery({ sessionId: "s1", projectScope, channel });
		expect(after.tombstones).toHaveLength(1);
		// A tombstone delivers no section body, so it refreshes no snapshot.
		expect(after.snapshots).toHaveLength(0);
		// Mirror the extension's tombstone queue: receipt and cache entry go.
		for (const tombstone of after.tombstones) state.clearReceipt("s1", "memory_record", tombstone.ref);
		state.deleteMemorySnapshots(
			"s1",
			after.tombstones.map((tombstone) => tombstone.ref),
		);
		expect(state.getMemorySnapshot("s1", ref)).toBeUndefined();
		// History truncation clears the whole session, and the cache mirrors it.
		state.upsertMemorySnapshot("s1", ref, 1, "body");
		state.clearSessionReceipts("s1");
		expect(state.getMemorySnapshot("s1", ref)).toBeUndefined();
	});
});

describe("memory line diff", () => {
	test("changed regions read -old then +new and Chinese lines round-trip", () => {
		expect(lineDiffRegions("今晚结算\n欠欠本三笔\n晚安", "今晚结算\n欠欠本两笔\n晚安")).toEqual([
			{ kind: "-", text: "欠欠本三笔" },
			{ kind: "+", text: "欠欠本两笔" },
		]);
	});

	test("append-only changes produce additions only", () => {
		expect(lineDiffRegions("line one\nline two", "line one\nline two\nline three")).toEqual([
			{ kind: "+", text: "line three" },
		]);
	});

	test("identical bodies produce an empty diff", () => {
		expect(lineDiffRegions("同一段\n正文", "同一段\n正文")).toEqual([]);
	});

	test("a common line inside the middle splits the diff into two regions", () => {
		expect(lineDiffRegions("a\nX1\nb\nY1\nc", "a\nX2\nb\nY2\nc")).toEqual([
			{ kind: "-", text: "X1" },
			{ kind: "+", text: "X2" },
			{ kind: "-", text: "Y1" },
			{ kind: "+", text: "Y2" },
		]);
	});

	test("an economical diff passes, a diff past half the new body is refused", () => {
		const keeps = Array.from({ length: 10 }, (_, i) => `keep line ${i}`).join("\n");
		expect(diffMemoryBodies(`same head\n${keeps}`, `edited head\n${keeps}`)).toEqual([
			{ kind: "-", text: "same head" },
			{ kind: "+", text: "edited head" },
		]);
		const newBody = Array.from({ length: 1000 }, (_, i) => `new ${i}`).join("\n");
		expect(diffMemoryBodies("totally\ndifferent", newBody)).toBeNull();
	});

	test("a middle wider than the LCS cell guard is refused", () => {
		const oldBody = Array.from({ length: 2500 }, (_, i) => `o${i}`).join("\n");
		const newBody = Array.from({ length: 1700 }, (_, i) => `n${i}`).join("\n");
		expect(diffMemoryBodies(oldBody, newBody)).toBeNull();
	});
});
