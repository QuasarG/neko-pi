import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { fitMemoryBudget } from "./memory/budget.ts";
import { atomicWrite, readState, withStorageLock } from "./storage.ts";
import { chooseOutfit, type Outfit, type Wardrobe } from "./wardrobe.ts";

export const ACTIVITY_RETENTION_MS = 21 * 24 * 60 * 60 * 1000;
const OUTFIT_IDLE_MS = 6 * 60 * 60 * 1000;
export type ActivityKind = "user_query" | "memory_updated" | "continuity_updated" | "outfit_changed";
export interface ActivityEvent {
	seq: number;
	time: number;
	session: string;
	directory: string;
	kind: ActivityKind;
	text: string;
	truncated: boolean;
}
interface ActivityState {
	version: 1;
	seq: number;
	prunedThrough: number;
	lastUserAt: number;
	sessions: Record<string, { seq: number; time: number }>;
	events: ActivityEvent[];
	outfit?: Outfit;
}
export interface ActivityContext {
	since?: number;
	through: number;
	events: ActivityEvent[];
	omitted: number;
	historyExpired: boolean;
	outfit?: Outfit;
}

export class ActivityStore {
	private readonly file: string;
	constructor(root = getAgentDir()) {
		this.file = join(root, "runtime", "activity.json");
	}

	private read(now: number): ActivityState {
		const value = readState(this.file);
		if (value === undefined) return { version: 1, seq: 0, prunedThrough: 0, lastUserAt: 0, sessions: {}, events: [] };
		if (!value || typeof value !== "object") throw new Error("Invalid activity state");
		const state = value as ActivityState;
		if (
			state.version !== 1 ||
			!Number.isSafeInteger(state.seq) ||
			!Number.isFinite(state.lastUserAt) ||
			!Number.isSafeInteger(state.prunedThrough) ||
			!state.sessions ||
			!Array.isArray(state.events)
		)
			throw new Error("Invalid activity state");
		const cutoff = now - ACTIVITY_RETENTION_MS;
		state.events = state.events.filter((event) => {
			if (!Number.isSafeInteger(event.seq) || !Number.isFinite(event.time) || typeof event.text !== "string")
				throw new Error("Invalid activity event");
			if (event.time >= cutoff) return true;
			state.prunedThrough = Math.max(state.prunedThrough, event.seq);
			return false;
		});
		for (const [id, cursor] of Object.entries(state.sessions)) {
			if (!cursor || !Number.isFinite(cursor.time) || !Number.isSafeInteger(cursor.seq))
				throw new Error("Invalid activity cursor");
			if (cursor.time < cutoff) delete state.sessions[id];
		}
		return state;
	}

	append(kind: ActivityKind, session: string, directory: string, text: string): void {
		withStorageLock(this.file, () => {
			const now = Date.now();
			const state = this.read(now);
			this.push(state, kind, session, directory, text, now);
			atomicWrite(this.file, JSON.stringify(state));
		});
	}

	private push(
		state: ActivityState,
		kind: ActivityKind,
		session: string,
		directory: string,
		text: string,
		now: number,
	): void {
		const bounded = fitMemoryBudget(text, 2000);
		state.events.push({
			seq: ++state.seq,
			time: now,
			session,
			directory,
			kind,
			text: bounded,
			truncated: bounded !== text,
		});
	}

	prepare(session: string, directory: string, query: string, wardrobe: Wardrobe, now = Date.now()): ActivityContext {
		return withStorageLock(this.file, () => {
			const state = this.read(now);
			const previous = Object.hasOwn(state.sessions, session) ? state.sessions[session] : undefined;
			const outfit = chooseOutfit(
				wardrobe,
				state.outfit,
				!state.lastUserAt || now - state.lastUserAt >= OUTFIT_IDLE_MS,
			);
			if (outfit && JSON.stringify(outfit) !== JSON.stringify(state.outfit))
				this.push(state, "outfit_changed", session, directory, outfit.name, now);
			state.outfit = outfit;
			const unseen = state.events.filter((event) => event.seq > (previous?.seq ?? 0));
			const events: ActivityEvent[] = [];
			let bytes = 0;
			for (const event of unseen.toReversed()) {
				const size = Buffer.byteLength(JSON.stringify(event));
				if (bytes + size > 8000) break;
				events.unshift(event);
				bytes += size;
			}
			const context: ActivityContext = {
				since: previous?.time,
				through: state.seq,
				events,
				omitted: unseen.length - events.length,
				historyExpired: (previous?.seq ?? 0) < state.prunedThrough,
				...(outfit ? { outfit } : {}),
			};
			this.push(state, "user_query", session, directory, query, now);
			state.sessions[session] = { seq: state.seq, time: now };
			state.lastUserAt = now;
			atomicWrite(this.file, JSON.stringify(state));
			return context;
		});
	}
}
