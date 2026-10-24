import type { ReadonlySessionManager } from "../session-manager.ts";

export const CONTINUITY_QUERY_ENTRY = "continuity.query";
export const CONTINUITY_SAVED_ENTRY = "continuity.persona.saved";
export const CONTINUITY_QUERY_INTERVAL = 3;
export const CONTINUITY_REQUIREMENT =
	"This query carries the session's three-user-query continuity checkpoint. " +
	"Before finishing your reply, call continuity_update with scope='persona' and a concise, factual summary of the current conversational stage and tone. " +
	"Project-scope writes do not satisfy this checkpoint. " +
	"If a newer session caused a conflict, merge its returned current summary and retry with its expected_version. " +
	"Keep the summary within the tool's UTF-8 byte budget; a skipped or rejected write leaves the checkpoint owed and it will be re-requested on the next query.";

/** Derive cadence from the active branch so reload, compaction, and truncation keep it consistent. */
export function personaContinuityCadence(manager: ReadonlySessionManager): {
	queries: number;
	block: number;
	due: boolean;
} {
	const entries = manager.getBranch();
	const sessionId = manager.getSessionId();
	const sources = new Map<string, { queryId?: string; internal?: boolean; sessionId?: string }>();
	let completed = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
		if (entry.customType === CONTINUITY_QUERY_ENTRY) {
			const data = entry.data as { entryId?: string; queryId?: string; internal?: boolean; sessionId?: string };
			if (typeof data.entryId === "string") sources.set(data.entryId, data);
		} else if (entry.customType === CONTINUITY_SAVED_ENTRY) {
			const data = entry.data as { block?: number; sessionId?: string };
			if (data.sessionId === sessionId && typeof data.block === "number" && Number.isInteger(data.block)) {
				completed = Math.max(completed, data.block);
			}
		}
	}
	const queries = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const source = sources.get(entry.id);
		if (!source?.internal && (!source?.sessionId || source.sessionId === sessionId))
			queries.add(source?.queryId ?? entry.id);
	}
	const block = Math.floor(queries.size / CONTINUITY_QUERY_INTERVAL);
	return { queries: queries.size, block, due: block > completed };
}
