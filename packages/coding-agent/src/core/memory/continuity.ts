import { join } from "node:path";
import { atomicWrite, readState, withStorageLock } from "../storage.ts";
import { fitMemoryBudget, MEMORY_BUDGET } from "./budget.ts";

interface ContinuityState {
	revision: number;
	session: string;
	updated: number;
	summary: string;
}

export class ContinuityStore {
	private readonly file: string;
	constructor(root: string) {
		this.file = join(root, "continuity.json");
	}

	read(): ContinuityState | undefined {
		const value = readState(this.file);
		if (!value || typeof value !== "object") return undefined;
		const state = value as Partial<ContinuityState>;
		if (
			typeof state.revision !== "number" ||
			typeof state.session !== "string" ||
			typeof state.updated !== "number" ||
			typeof state.summary !== "string"
		)
			return undefined;
		return state as ContinuityState;
	}

	claim(session: string): number {
		return withStorageLock(this.file, () => {
			const previous = this.read();
			const state: ContinuityState = {
				revision: (previous?.revision ?? 0) + 1,
				session,
				updated: previous?.updated ?? 0,
				summary: previous?.summary ?? "",
			};
			atomicWrite(this.file, JSON.stringify(state));
			return state.revision;
		});
	}

	commit(revision: number, summary: string, apply?: () => void): boolean {
		return withStorageLock(this.file, () => {
			const current = this.read();
			if (!current || current.revision !== revision) return false;
			apply?.();
			atomicWrite(
				this.file,
				JSON.stringify({
					...current,
					updated: Date.now(),
					summary: fitMemoryBudget(summary.trim(), MEMORY_BUDGET.continuity - 100),
				}),
			);
			return true;
		});
	}

	context(): string {
		const state = this.read();
		if (!state?.summary || Date.now() - state.updated > 6 * 60 * 60 * 1000) return "";
		return fitMemoryBudget(
			`Recent shared continuity (${new Date(state.updated).toISOString()}):\n${state.summary}`,
			MEMORY_BUDGET.continuity,
		);
	}
}
