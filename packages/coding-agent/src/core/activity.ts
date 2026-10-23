import { fitMemoryBudget } from "./memory/budget.ts";
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
	scope: "persona" | "project";
	projectId: string | null;
	kind: string;
	payload: string;
}

export interface ActivityContext {
	since?: number;
	through: number;
	events: ActivityEvent[];
	omitted: number;
	historyExpired: boolean;
	outfit?: Outfit;
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
			payload: fitMemoryBudget(text, 2000),
		});
	}

	/**
	 * Freeze the activity context for a newly received message: unseen events
	 * within this session's visible scopes, the current outfit (reselected
	 * only after six idle hours), and the cursor the message will carry.
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
				payload: outfit.name,
				now,
			});
		}

		const since = receipt?.version ?? 0;
		// Per-event receipts (tool results already in history) skip single
		// events without moving the cursor past older unknown ones (C04/C06).
		const { events, omitted } = this.state.activitiesSince(
			since,
			projectId,
			ACTIVITY_BUDGET_BYTES,
			this.state.knownEventSeqs(session),
		);
		const prunedThrough = this.state.activityPrunedThrough(now, ACTIVITY_RETENTION_MS);
		const context: ActivityContext = {
			since: receipt ? receipt.time : undefined,
			through,
			events,
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
