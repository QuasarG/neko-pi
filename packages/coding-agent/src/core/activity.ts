import { type MemoryScope, resolveProjectIdentity, scopeKey } from "./runtime/identity.ts";
import { getRuntimeState, type RuntimeState } from "./runtime/state-db.ts";
import { chooseOutfit, type Outfit, type Wardrobe } from "./wardrobe.ts";

export const ACTIVITY_RETENTION_MS = 21 * 24 * 60 * 60 * 1000;
export const OUTFIT_IDLE_MS = 6 * 60 * 60 * 1000;
export const ACTIVITY_BUDGET_BYTES = 8000;

export type ActivityKind = "user_query" | "memory_updated" | "continuity_updated" | "outfit_changed";

export interface ActivityEvent {
	seq: number;
	time: number;
	session: string | null;
	scope: "persona" | "project" | "scratch";
	projectId: string | null;
	kind: string;
	payload: string;
}

export interface ActivityContext {
	since?: number;
	through: number;
	sessions: ActivitySessionSummary[];
	omitted: number;
	historyExpired: boolean;
	outfit?: Outfit;
	/** Legacy snapshots only; newly prepared contexts omit raw events. */
	events?: ActivityEvent[];
}

/** One session's contribution to the activity digest, most recent first. */
export interface ActivitySessionSummary {
	session: string;
	firstSeen: number;
	lastSeen: number;
	queries: number;
	recentQueries: string[];
	memoryUpdates: string[];
	continuityUpdates: number;
	outfitChanges: number;
}

const RECENT_QUERY_PREVIEWS = 2;
const UNIQUE_MEMORY_UPDATES = 5;
const NO_SESSION_KEY = "(no session)";

const PREVIEW_LIMIT_BYTES = { continuity: 180, other: 240 } as const;
const ELLIPSIS = "…";

/**
 * Bounded preview for newly stored activity rows: never splits a UTF-8 code
 * point, and appends an ellipsis only when it actually cut text. Existing
 * rows are never rewritten — only future payloads shrink.
 */
function previewText(kind: string, text: string): string {
	const budget = kind === "continuity_updated" ? PREVIEW_LIMIT_BYTES.continuity : PREVIEW_LIMIT_BYTES.other;
	if (Buffer.byteLength(text, "utf8") <= budget) return text;
	const marker = Buffer.byteLength(ELLIPSIS, "utf8");
	let kept = "";
	let used = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character, "utf8");
		if (used + size + marker > budget) break;
		kept += character;
		used += size;
	}
	return kept + ELLIPSIS;
}

/**
 * Collapse a selected raw-event window into per-session summaries: grouped
 * by session, ordered by most recent activity, with bounded query previews,
 * unique memory-update labels, and counted continuity/outfit changes. The
 * raw rows stay in SQLite for audit; this is only the delivery shape.
 */
export function summarizeActivityEvents(events: ActivityEvent[]): ActivitySessionSummary[] {
	const groups = new Map<string, ActivitySessionSummary>();
	for (const event of events) {
		const key = event.session ?? NO_SESSION_KEY;
		let summary = groups.get(key);
		if (!summary) {
			summary = {
				session: key,
				firstSeen: event.time,
				lastSeen: event.time,
				queries: 0,
				recentQueries: [],
				memoryUpdates: [],
				continuityUpdates: 0,
				outfitChanges: 0,
			};
			groups.set(key, summary);
		}
		summary.firstSeen = Math.min(summary.firstSeen, event.time);
		summary.lastSeen = Math.max(summary.lastSeen, event.time);
		if (event.kind === "user_query") {
			summary.queries += 1;
			// Events arrive in sequence order, so push+shift keeps the newest.
			summary.recentQueries.push(event.payload);
			if (summary.recentQueries.length > RECENT_QUERY_PREVIEWS) summary.recentQueries.shift();
		} else if (event.kind === "memory_updated") {
			if (!summary.memoryUpdates.includes(event.payload) && summary.memoryUpdates.length < UNIQUE_MEMORY_UPDATES)
				summary.memoryUpdates.push(event.payload);
		} else if (event.kind === "continuity_updated") {
			summary.continuityUpdates += 1;
		} else if (event.kind === "outfit_changed") {
			summary.outfitChanges += 1;
		}
	}
	return [...groups.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * Global activity log over the shared runtime database. Queries are always
 * scope-filtered: a session sees persona events plus its own project's
 * events, never another project's. The 21-day retention only prunes the
 * activity log; snapshots already delivered into message history stay as
 * they were.
 */
export class ActivityStore {
	private readonly state: RuntimeState;

	constructor(state: RuntimeState = getRuntimeState()) {
		this.state = state;
	}

	private receiptKey(projectId: string): string {
		return scopeKey({ scope: "project", projectId });
	}

	append(kind: ActivityKind, session: string, projectId: string | null, text: string, scope?: MemoryScope): number {
		const effective: MemoryScope = scope ?? (projectId ? { scope: "project", projectId } : { scope: "persona" });
		return this.state.appendActivity({
			session,
			scope: effective,
			kind,
			payload: previewText(kind, text),
		});
	}

	/**
	 * Freeze the activity context for a newly received message: unseen events
	 * within this session's visible scopes summarized per session (raw rows
	 * are never delivered), the current outfit (reselected only after six
	 * idle hours), and the cursor the message will carry.
	 */
	prepare(
		session: string,
		cwd: string,
		query: string,
		wardrobe: Wardrobe,
		now = Date.now(),
	): { context: ActivityContext; projectId: string } {
		const identity = resolveProjectIdentity(cwd);
		this.state.ensureProject(identity);
		const projectId = identity.projectId;
		const receipt = this.state.getReceipt(session, "activity", this.receiptKey(projectId));
		const through = this.state.lastActivitySeq();

		// Capture the previous selection before choosing: selection itself
		// persists, so reading after would never see a change (R05).
		const previousOutfit = this.state.getWardrobeState().current;
		const outfit = this.selectOutfit(session, wardrobe, now);
		if (outfit && previousOutfit !== outfit.id) {
			this.state.appendActivity({
				session,
				scope: { scope: "persona" },
				kind: "outfit_changed",
				// id and name together: audits must identify both fields.
				payload: previewText("outfit_changed", `${outfit.id}: ${outfit.name}`),
				now,
			});
		}

		const since = receipt?.version ?? 0;
		// Per-event receipts (tool results already in history) skip single
		// events without moving the cursor past older unknown ones (C04/C06).
		// The digest cap on query previews also reserves each session's newest
		// queries inside the selection: a burst of continuity or memory rows
		// must not evict the queries the cross-session tracker exists for.
		const { events, omitted } = this.state.activitiesSince(
			since,
			projectId,
			ACTIVITY_BUDGET_BYTES,
			this.state.knownEventSeqs(session),
			RECENT_QUERY_PREVIEWS,
		);
		const prunedThrough = this.state.activityPrunedThrough(now, ACTIVITY_RETENTION_MS);
		const context: ActivityContext = {
			since: receipt ? receipt.time : undefined,
			through,
			sessions: summarizeActivityEvents(events),
			omitted,
			historyExpired: since < prunedThrough,
			...(outfit ? { outfit } : {}),
		};

		this.state.appendActivity({
			session,
			scope: { scope: "project", projectId },
			kind: "user_query",
			payload: query,
			now,
		});
		this.state.markReceipt(session, "activity", this.state.lastActivitySeq(), this.receiptKey(projectId));
		this.state.pruneActivities(now, ACTIVITY_RETENTION_MS);
		return { context, projectId };
	}

	/**
	 * After a session truncation (/edit), the activity cursor must skip past
	 * all existing events — including the deleted messages' queries — so the
	 * resent message starts with a clean activity view instead of replaying
	 * every historical query as "unseen".
	 */
	advanceCursorAfterTruncation(session: string, cwd: string): void {
		const projectId = resolveProjectIdentity(cwd).projectId;
		this.state.markReceipt(session, "activity", this.state.lastActivitySeq(), this.receiptKey(projectId));
	}

	/** Outfit choice is global: one selection per idle window, shared by all sessions. */
	private selectOutfit(_session: string, wardrobe: Wardrobe, now: number): Outfit | undefined {
		const outfits = wardrobe.outfits.map((outfit) => ({ ...outfit, enabled: true }));
		this.state.importWardrobe(outfits, wardrobe.locked ?? null);
		const state = this.state.getWardrobeState();
		const previous = state.current ? outfits.find((outfit) => outfit.id === state.current) : undefined;
		const idle = !state.lastUserAt || now - state.lastUserAt >= OUTFIT_IDLE_MS;
		const chosen = chooseOutfit({ outfits, ...(wardrobe.locked ? { locked: wardrobe.locked } : {}) }, previous, idle);
		if (chosen) this.state.setWardrobeSelection(chosen.id, now);
		else this.state.setWardrobeSelection(null, now);
		return chosen;
	}
}
