import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { clearTurnJournal, recordOriginal } from "../../core/turn-file-journal.ts";

/**
 * File-undo journal: snapshots files before the running turn's write/edit
 * tools modify them, keyed by the latest user entry. A new user turn wipes
 * the journal, so `/undo` always targets exactly the last round. Bash-driven
 * file changes are NOT journaled (a shell can touch anything) — /undo says
 * so instead of pretending.
 */
const undoJournalExtension: ExtensionFactory = (pi) => {
	pi.on("before_agent_start", (event) => {
		// Only a real user turn resets scope; extension-authored custom
		// messages run inside an existing turn and must not wipe it.
		if (event.messageType === "user") clearTurnJournal();
	});
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const path = event.input.path;
		if (typeof path !== "string" || path === "") return;
		const lastUser = ctx.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "message" && entry.message.role === "user");
		if (!lastUser || lastUser.type !== "message") return;
		recordOriginal(lastUser.id, path);
	});
};

export default undoJournalExtension;
