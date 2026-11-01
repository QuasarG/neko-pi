/**
 * Per-record memory delivery: decide, for one session about to run a user
 * message, which individual records must enter the prompt.
 *
 * The old model re-sent a whole scope snapshot whenever the scope version
 * moved; one changed record re-delivered every record in persona plus the
 * current project. Here every visible record carries its own receipt keyed
 * by a fingerprint of its stable content payload (version and updated
 * counters excluded, so a no-op merge does not re-inject): a new session
 * gets one budgeted baseline, afterwards a record whose content changed is
 * re-sent as a line diff against the body this session last received (the
 * full body when that copy is not on file), and records that vanished leave
 * a short withdrawal (tombstone) instead of silently disappearing.
 *
 * Rendering and receipt classification are pure — buildMemoryDelivery never
 * writes a receipt; the caller queues them behind the pending-turn
 * discipline (commit only after the user message is durably persisted).
 */

import { join } from "node:path";
import { GLOBAL_SCOPES, type MemoryScope, scopeKey } from "../runtime/identity.ts";
import { hashText } from "../runtime/state-db.ts";
import type { MemoryChannel } from "./channel.ts";
import { diffMemoryBodies } from "./diff.ts";
import type { MemoryRecord } from "./store.ts";
import { serializeMemoryRecord, stableRecordId } from "./store.ts";

/**
 * Delivery budgets equal the active storage ceilings: every record the scope
 * is allowed to hold must remain deliverable, otherwise the second, smaller
 * bound silently starves whole documents (found on real data: six persona
 * books totalling ~18 KiB against a 16 KiB delivery cap left one book
 * permanently un-injected). Steady-state delivery is still only the records
 * that changed; the full scope is a baseline or a mass-update event.
 */
export const MEMORY_DELIVERY_BUDGETS = {
	persona: 64 * 1024,
	toolbox: 32 * 1024,
	project: 32 * 1024,
	scratch: 16 * 1024,
} as const;

/** Receipt kind for per-record delivery receipts. */
export const MEMORY_RECORD_RECEIPT = "memory_record";

export interface MemoryDeliveryRecord {
	scope: MemoryScope;
	record: MemoryRecord;
	reason: "baseline" | "new" | "updated";
}

export interface MemoryDelivery {
	/** Rendered Markdown sections, ready for the <runtime_memory> block body. */
	sections: string[];
	/** Receipts to queue for every delivered (fitted) record. */
	receipts: Array<{ ref: string; fingerprint: number }>;
	/**
	 * Snapshot upserts for every delivered section: the body this query put
	 * in context, so the next update can diff against it. The caller queues
	 * them beside the receipts — same purity, same persistence discipline.
	 */
	snapshots: Array<{ ref: string; version: number; body: string }>;
	/** Delivered records that are no longer visible; receipt refs to clear. */
	tombstones: Array<{ ref: string; scopeKey: string; recordId: string }>;
	/** Records that wanted delivery but exceeded the per-scope budget. */
	omitted: Array<{ scope: MemoryScope; title: string; file: string }>;
}

/**
 * Canonical stable payload of a record for fingerprinting: every content
 * field except the volatile `version` and `updated` counters. A no-op merge
 * bumps those without changing what the model reads, so it must not
 * re-inject; a change to type, title, body, salience, status, tags,
 * archival state, scratch provenance, or creation date does.
 *
 * The creation date enters only when parsed from the file (`createdKnown`):
 * a shell-damaged frontmatter falls back to `new Date()`, and hashing that
 * wall-clock value would re-deliver the record forever — unknown dates
 * hash null, so a static file yields a static fingerprint.
 */
export function recordStablePayload(record: MemoryRecord): string {
	return JSON.stringify([
		record.id ?? stableRecordId(record.type, record.title),
		record.type,
		record.title,
		record.body,
		record.salience,
		record.status ?? null,
		record.tags,
		record.archived === true,
		record.originSessionId ?? null,
		record.originCwd ?? null,
		record.targetProjectId ?? null,
		record.createdKnown === false ? null : record.created.toISOString(),
	]);
}

/** Fingerprint of a record: first 8 hex chars of the stable-payload hash. */
export function recordFingerprint(record: MemoryRecord, payload?: string): number {
	return Number.parseInt(hashText(payload ?? recordStablePayload(record)).slice(0, 8), 16);
}

/** Receipt ref for one record: `<scopeKey>#<recordId>`. */
export function recordReceiptRef(scope: MemoryScope, recordId: string): string {
	return `${scopeKey(scope)}#${recordId}`;
}

function scopeLabel(scope: MemoryScope): string {
	if (scope.scope === "persona") return "persona";
	if (scope.scope === "toolbox") return "toolbox";
	if (scope.scope === "scratch") return "scratch";
	return `project ${scope.projectId.slice(0, 8)}`;
}

function scopeLabelOfKey(key: string): string {
	return key.startsWith("project:") ? `project ${key.slice("project:".length, "project:".length + 8)}` : key;
}

function budgetOf(scope: MemoryScope): number {
	if (scope.scope === "persona") return MEMORY_DELIVERY_BUDGETS.persona;
	if (scope.scope === "toolbox") return MEMORY_DELIVERY_BUDGETS.toolbox;
	if (scope.scope === "project") return MEMORY_DELIVERY_BUDGETS.project;
	return MEMORY_DELIVERY_BUDGETS.scratch;
}

/** Absolute path of a record file inside its scope store. */
function absoluteRecordFile(channel: MemoryChannel, scope: MemoryScope, record: MemoryRecord): string {
	return join(channel.store(scope).dir, record.file ?? "");
}

interface ScopedRecord {
	scope: MemoryScope;
	record: MemoryRecord;
}

/**
 * Records visible to one session: every persona record, the current
 * project's records, and scratch records this session created. Ordered
 * persona, project, scratch; within a scope, newest updated first.
 */
export function visibleScopedRecords(input: {
	sessionId: string;
	projectScope: MemoryScope;
	channel: MemoryChannel;
}): ScopedRecord[] {
	const result: ScopedRecord[] = [];
	// Every session sees the persona books and the person's toolbox, then the
	// current project's shelf, then its own scratch records.
	for (const scope of [...GLOBAL_SCOPES, input.projectScope, { scope: "scratch" } as const]) {
		const records = input.channel
			.store(scope)
			.list(true)
			.filter((record) => record.id);
		const visible =
			scope.scope === "scratch" ? records.filter((record) => record.originSessionId === input.sessionId) : records;
		for (const record of visible) result.push({ scope, record });
	}
	return result;
}

/** Flat form of {@link visibleScopedRecords} for callers that need no scope tags. */
export function visibleMemoryRecords(input: {
	sessionId: string;
	projectScope: MemoryScope;
	channel: MemoryChannel;
}): MemoryRecord[] {
	return visibleScopedRecords(input).map((entry) => entry.record);
}

/** Body this session last received for a record, from the delivery snapshot cache. */
interface DeliveredBody {
	version: number;
	body: string;
}

function renderRecordSection(
	channel: MemoryChannel,
	entry: ScopedRecord,
	reason: "baseline" | "new" | "updated",
	delivered?: DeliveredBody,
): string {
	const { scope, record } = entry;
	const heading = reason === "updated" ? "Memory update" : "Memory baseline";
	const serialized = serializeMemoryRecord(record);
	const lines = [
		`### ${heading}: ${scopeLabel(scope)}`,
		`- record: ${record.title}`,
		`- type: ${record.type} · version: ${record.version ?? 1} · bytes: ${Buffer.byteLength(serialized)}`,
		`- file: ${absoluteRecordFile(channel, scope, record)}`,
	];
	if (reason !== "updated") {
		lines.push("", record.body);
		return lines.join("\n");
	}
	// Updates carry only the change from the copy the model already holds:
	// a diff against the delivered snapshot, or the honest full body when
	// that copy is not on file (pre-upgrade sessions, pruned cache).
	if (!delivered) {
		lines.push("- update: full (snapshot unavailable)", "", record.body);
		return lines.join("\n");
	}
	const diff = diffMemoryBodies(delivered.body, record.body);
	if (diff === null) {
		lines.push("- update: full (diff not smaller)", "", record.body);
		return lines.join("\n");
	}
	lines.push(`- update: diff against delivered v${delivered.version}`, "");
	if (diff.length === 0) {
		lines.push("No content lines changed; only record metadata moved.");
		return lines.join("\n");
	}
	lines.push(...diff.map((line) => `${line.kind} ${line.text}`));
	return lines.join("\n");
}

function renderTombstoneSection(tombstone: { scopeKey: string; recordId: string }): string {
	return [
		`### Memory removed: ${scopeLabelOfKey(tombstone.scopeKey)}`,
		`- record_id: ${tombstone.recordId}`,
		"A previously delivered record no longer exists; discard its earlier content.",
	].join("\n");
}

function renderOmissionNotice(scope: MemoryScope, omitted: Array<{ title: string; file: string }>): string {
	const listed = omitted.map((entry) => `${entry.title} (${entry.file})`).join("; ");
	// The exact wording "N more records exceeded" is what the frontend parser
	// counts; keep it verbatim even when N is 1 (matches the legacy note).
	return `(${omitted.length} more records exceeded the ${budgetOf(scope)}-byte ${scopeLabel(
		scope,
	)} delivery budget: ${listed}; read them with the read tool)`;
}

/**
 * Scope keys with pending delivery work for one session: any record waiting
 * for a baseline/update, any budget omission, any undelivered tombstone.
 * The /context audit renders this as "delivered" vs "changes pending
 * injection"; an empty set means the next query injects nothing.
 */
export function pendingDeliveryScopes(input: {
	sessionId: string;
	projectScope: MemoryScope;
	channel: MemoryChannel;
}): Set<string> {
	const delivery = buildMemoryDelivery(input);
	const keys = new Set<string>();
	for (const receipt of delivery.receipts) {
		const separator = receipt.ref.indexOf("#");
		keys.add(separator === -1 ? receipt.ref : receipt.ref.slice(0, separator));
	}
	for (const tombstone of delivery.tombstones) keys.add(tombstone.scopeKey);
	for (const entry of delivery.omitted) keys.add(scopeKey(entry.scope));
	return keys;
}

/**
 * Compute one session's per-record delivery against its existing receipts.
 * Pure with respect to receipts: it reads them, never writes; the caller
 * queues {@link MemoryDelivery.receipts} marks and {@link MemoryDelivery.tombstones}
 * clears behind its own persistence discipline.
 */
export function buildMemoryDelivery(input: {
	sessionId: string;
	projectScope: MemoryScope;
	channel: MemoryChannel;
}): MemoryDelivery {
	const { sessionId, projectScope, channel } = input;
	const state = channel.stateRef;
	const visible = visibleScopedRecords({ sessionId, projectScope, channel });
	const existing = new Map(state.listReceipts(sessionId, MEMORY_RECORD_RECEIPT).map((row) => [row.ref, row]));
	// With no record receipts at all this session is fresh: everything it
	// sees is a baseline. Once anything was delivered, a never-seen record
	// appearing mid-session is a "new" delivery, not a new baseline.
	const fresh = existing.size === 0;

	const sections: string[] = [];
	const receipts: MemoryDelivery["receipts"] = [];
	const snapshots: MemoryDelivery["snapshots"] = [];
	const omittedByScope = new Map<string, { scope: MemoryScope; items: Array<{ title: string; file: string }> }>();
	const usedByScope = new Map<string, number>();

	for (const entry of visible) {
		const recordId = entry.record.id!;
		const ref = recordReceiptRef(entry.scope, recordId);
		const fingerprint = recordFingerprint(entry.record);
		const receipt = existing.get(ref);
		const reason: MemoryDeliveryRecord["reason"] | undefined = !receipt
			? fresh
				? "baseline"
				: "new"
			: receipt.version === fingerprint
				? undefined
				: "updated";
		if (reason === undefined) continue;
		// Updates diff against the body this session last received; the
		// snapshot is a cache, so a missing row degrades to the full body.
		const snapshotRow = reason === "updated" ? state.getMemorySnapshot(sessionId, ref) : undefined;
		const section = renderRecordSection(
			channel,
			entry,
			reason,
			snapshotRow ? { version: snapshotRow.recordVersion, body: snapshotRow.body } : undefined,
		);
		const key = scopeKey(entry.scope);
		const used = usedByScope.get(key) ?? 0;
		if (used + Buffer.byteLength(section) > budgetOf(entry.scope)) {
			// A body that does not fit is omitted whole, never truncated; the
			// record earns no receipt and stays pending for a leaner query.
			let bucket = omittedByScope.get(key);
			if (!bucket) {
				bucket = { scope: entry.scope, items: [] };
				omittedByScope.set(key, bucket);
			}
			bucket.items.push({ title: entry.record.title, file: absoluteRecordFile(channel, entry.scope, entry.record) });
			continue;
		}
		usedByScope.set(key, used + Buffer.byteLength(section));
		sections.push(section);
		receipts.push({ ref, fingerprint });
		// Every delivered section refreshes the cache: the next update diffs
		// against exactly what this query put in context.
		snapshots.push({ ref, version: entry.record.version ?? 1, body: entry.record.body });
	}

	const currentProjectKey = scopeKey(projectScope);
	const visibleRefs = new Set(visible.map((entry) => recordReceiptRef(entry.scope, entry.record.id!)));
	const tombstones: MemoryDelivery["tombstones"] = [];
	for (const row of state.listReceipts(sessionId, MEMORY_RECORD_RECEIPT)) {
		if (visibleRefs.has(row.ref)) continue;
		const separator = row.ref.indexOf("#");
		const key = separator === -1 ? row.ref : row.ref.slice(0, separator);
		const recordId = separator === -1 ? "" : row.ref.slice(separator + 1);
		// A project receipt from a cwd this session moved away from is not a
		// removal: the record is alive, just out of sight here.
		if (key.startsWith("project:") && key !== currentProjectKey) continue;
		tombstones.push({ ref: row.ref, scopeKey: key, recordId });
	}
	for (const tombstone of tombstones) sections.push(renderTombstoneSection(tombstone));
	// Omission is honest even when the scope delivered nothing else: a sole
	// oversized record must be named with its file every query, not vanish
	// silently because no section carried the notice.
	for (const bucket of omittedByScope.values()) sections.push(renderOmissionNotice(bucket.scope, bucket.items));

	return {
		sections,
		receipts,
		snapshots,
		tombstones,
		omitted: [...omittedByScope.values()].flatMap((bucket) =>
			bucket.items.map((item) => ({ scope: bucket.scope, title: item.title, file: item.file })),
		),
	};
}
