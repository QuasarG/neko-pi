import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ActivityStore } from "./activity.ts";
import type { AgentSession } from "./agent-session.ts";
import { getRuntimeState } from "./runtime/state-db.ts";
import { atomicWrite } from "./storage.ts";

/**
 * Remove a user turn and every later file entry from the persisted session,
 * restoring the original file if the reload fails. Core primitive behind
 * "edit and resend": the message menu truncates, the composer re-fills.
 */
export async function truncateNativeSession(session: AgentSession, entryId: string): Promise<void> {
	const manager = session.sessionManager;
	const entry = manager.getBranch().find((item) => item.id === entryId);
	if (entry?.type !== "message" || entry.message.role !== "user") {
		throw new Error("Truncation requires a user message on the active branch");
	}
	const file = manager.getSessionFile();
	if (!file) throw new Error("No persisted session file to truncate");
	const original = readFileSync(file, "utf8");
	const lines = original.trimEnd().split("\n");
	const boundary = lines.findIndex((line) => (JSON.parse(line) as { id?: string }).id === entryId);
	if (boundary < 1) throw new Error("Native message boundary is not persisted");
	const prefix = lines.slice(0, boundary);
	// Retain earlier branches, but persist the selected parent as the reopened leaf.
	const last = JSON.parse(prefix.at(-1)!) as { id: string; type: string };
	if ((last.type === "session" ? null : last.id) !== entry.parentId) {
		prefix.push(
			JSON.stringify({
				type: "custom",
				customType: "session.truncate",
				id: randomUUID(),
				parentId: entry.parentId,
				timestamp: new Date().toISOString(),
			}),
		);
	}
	atomicWrite(file, `${prefix.join("\n")}\n`);
	try {
		manager.setSessionFile(file);
		session.refreshContext();
		await session.reload();
		// The removed history carried injected text (memory, continuity, activity)
		// whose delivery receipts still stand — drop them so the resent message
		// receives everything the truncated context lost.
		//
		// Activity events themselves survive in the global log; clearSessionReceipts
		// resets the cursor to zero, which would replay every historical query as
		// "unseen" — including the ones just deleted. Advance the activity cursor
		// to the current latest instead, so only genuinely new events follow.
		const state = getRuntimeState();
		state.clearSessionReceipts(manager.getSessionId());
		const activityStore = new ActivityStore(state);
		activityStore.advanceCursorAfterTruncation(manager.getSessionId(), manager.getCwd());
	} catch (error) {
		atomicWrite(file, original);
		manager.setSessionFile(file);
		session.refreshContext();
		throw error;
	}
}
