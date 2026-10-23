import { type MemoryScope, scopeKey } from "../runtime/identity.ts";
import { getRuntimeState, type RuntimeState } from "../runtime/state-db.ts";
import { fitMemoryBudget, MEMORY_BUDGET } from "./budget.ts";

export const CONTINUITY_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Cross-session continuity over the shared runtime database. Persona and
 * each project keep independent rows; a claim from one scope never blocks a
 * write in another. Claims are optimistic: only the newest claim may commit.
 */
export class ContinuityStore {
	private readonly state: RuntimeState;
	private readonly key: string;
	private readonly scope: MemoryScope;

	constructor(state: RuntimeState = getRuntimeState(), scope: MemoryScope = { scope: "persona" }) {
		this.state = state;
		this.scope = scope;
		this.key = scopeKey(scope);
	}

	read(): { version: number; session: string; updated: number; summary: string } | undefined {
		const row = this.state.getContinuity(this.key);
		if (!row) return undefined;
		return { version: row.version, session: "", updated: row.updated, summary: row.content };
	}

	/** Reserve the next revision for this session; older claims go stale. */
	claim(_session: string): number {
		const current = this.state.getContinuity(this.key);
		const claimed = this.state.setContinuity({
			key: this.key,
			scope: this.scope,
			content: current?.content ?? "",
			expires: current?.expires ?? null,
			// Claim only succeeds when nobody else claimed in between.
			expectedVersion: current?.version ?? 0,
			// Keep the previous stamp: reserving a turn must not resurrect an
			// expired snapshot (P2).
			updatedAt: current?.updated,
		});
		if (!claimed.saved) {
			// Lost the race: a newer claim exists, so this ticket can never commit.
			return -1;
		}
		return claimed.version;
	}

	commit(revision: number, summary: string, apply?: () => void): boolean {
		const current = this.state.getContinuity(this.key);
		if (!current || current.version !== revision) return false;
		const saved = this.state.setContinuity({
			key: this.key,
			scope: this.scope,
			content: fitMemoryBudget(summary.trim(), MEMORY_BUDGET.continuity - 100),
			expires: Date.now() + CONTINUITY_TTL_MS,
			expectedVersion: revision,
		});
		if (!saved.saved) return false;
		apply?.();
		return true;
	}

	/** Bounded recent-state text, empty once the snapshot is older than six hours. */
	context(): string {
		const row = this.state.getContinuity(this.key);
		if (!row?.content || Date.now() - row.updated > CONTINUITY_TTL_MS) return "";
		return fitMemoryBudget(
			`Recent shared continuity (${new Date(row.updated).toISOString()}):\n${row.content}`,
			MEMORY_BUDGET.continuity,
		);
	}
}
