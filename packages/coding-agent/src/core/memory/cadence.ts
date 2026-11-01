import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { CONTINUITY_SUMMARY_BUDGET } from "./budget.ts";

export const CONTINUITY_QUERY_ENTRY = "continuity.query";
export const CONTINUITY_SAVED_ENTRY = "continuity.persona.saved";
export const CONTINUITY_REMINDER_INTERVAL = 10;
export const MEMORY_CHECKPOINT_ENTRY = "memory.checkpoint.saved";
export const MEMORY_UPDATE_INTERVAL = 10;
/**
 * Permanent system-prompt sections: byte-identical on every query, so the
 * prompt prefix (and its provider cache) never toggles. Per-turn nudges are
 * appended to the user message instead — the tail of the prompt, where
 * change is free.
 */
export const CONTINUITY_RULE_SECTION =
	"Continuity routing: continuity_update defaults to the current project scope, which records only the work stage of this project — what is being done, blockers, and the next steps — and is invisible to other projects. " +
	"Pass scope='persona' explicitly to record only the personal interaction stage, which is shared across projects. " +
	"Work content in persona or personal content in project is a routing failure: correct it by rewriting the correct scope. " +
	"Update a scope when its stage materially changes or when a milestone ends; leave unchanged stages alone, and replace the prior summary instead of appending to it. " +
	`Keep the summary within ${CONTINUITY_SUMMARY_BUDGET} UTF-8 bytes (about ${Math.floor(CONTINUITY_SUMMARY_BUDGET / 3)} Chinese characters) or the write is rejected. ` +
	"On every tenth user query the harness appends a one-query reminder; it is not owed — skipping it creates no debt, and the next reminder comes ten queries later. " +
	"If a newer session caused a version conflict, merge the returned current summary and retry with its expected_version.";
export const MEMORY_RULE_SECTION =
	"Memory cadence — aim for the middle course between spam and starvation. " +
	"The bar is durable value: write in the same turn when the conversation establishes something a future session would need; skip momentary flavor that only matters right now, and merge into existing records instead of duplicating. " +
	"Before any write, walk this decision tree in order — \n" +
	"Q1 Would this information lose its value when the current task ends? Ask: if a brand-new session tomorrow did the same job, would it still need this sentence — or does it die with this conversation's context and intermediate artifacts? (Example: '14 placeholders left to fill in the deck' — tomorrow's session opens the file and sees them, no record needed. Counter-example: 'the user minds anyone touching his browser cache' — any session benefits.) → If it dies with the task: do not record; the artifact carries its own state (open the file, run the tool, read the table). Only an in-progress stage that must survive into another session TODAY goes on the continuity note (continuity_update, one note per scope, 6-hour expiry; overnight backlog never relies on it). \n" +
	"Q2 Would a session 30 days from now, hitting a similar situation without this sentence, behave differently than the user expects? → No: do not record. Yes: continue. \n" +
	"Q3 Is this a rule or prohibition the user just set by voice, meant to hold from now on? The sentence itself is imperative — 'from now on don't X', 'remember never to Y', 'X is off-limits' — and the user expects it to stay in force. ('Don't clean my browser cache' is; 'my GPA is 3.68' is not — that is a fact, go to Q4.) → Yes: ask what the order GOVERNS. Governs a machine, tool, network, or file (browser, DNS, backups, cleanup)? That is machine discipline, not persona — fall through to Q4's work-knowledge branch. Governs how you two interact (clothing, intimacy timing, address, boundaries)? → the 主人的规矩 section of 主人的承诺 (promise). Governs how work gets done (review style, reporting format, delegation)? → 工作协作偏好 (profile, work book). \n" +
	"Q4 Is this sentence about who the user is, how to work with him, or the work itself? \n" +
	"- Basic attributes of the user, unchanging descriptive facts (name, school, major, contact, stack, research direction, body): would this sentence fit on a résumé? → 主人的档案 (profile). Any 'require/don't/always' wording is NOT résumé material — that was Q3. \n" +
	"- How he wants work done with him: review style, reporting format, delegation habits, delivery rhythm → 工作协作偏好 (profile, work book). \n" +
	"- Work knowledge: tool pitfalls, environments, servers, accounts, workflows, machine rules — things a different person doing the job would also need to know. Ask: which workspace does this knowledge belong to — is it the current working directory? Not bound to any workspace (about this machine, this NAS, this tool itself — true in any project): toolbox, the matching section of 工程经验. Bound to the current working directory: project scope. Bound to another workspace: if you know its path → scope=scratch with origin_cwd=<that path>, then memory_promote it there; if not → ask the user for the real project path, or file plain scratch and let it wait to be claimed when that project comes up. Cannot even name a workspace → scratch. \n" +
	"- A day's narrative of what was done ('today I finished X') is knowledge for no shelf — shelves hold distilled knowledge, not stories. \n" +
	"- Something that happened between you two (not a rule, not an attribute): a promise or reward/punishment owed → 主人的承诺 (promise); a relationship milestone, firsts and anniversaries → 纪念日 (anchor, append-only); daily shared life, intimate included → 亲密日记 (episode, 30-day rolling). \n" +
	"- Nothing fits or you cannot tell → scratch (private to this session until promoted). \n" +
	"Irons: one fact lives on exactly one shelf, never two; the episode type exists only in persona (the diary) — project and toolbox hold procedure/anchor only; recall the same topic first and merge instead of creating a new record — a merge must submit the FULL body, never just the delta; memory only holds what the artifacts and the world cannot tell you. " +
	"An order routes by what it governs, not by who said it: 'don't clean my browser cache' is machine discipline for the toolbox, not part of the user's profile. " +
	"Task state and one-off events are never profile material. " +
	"Preference statements are the classic durable case: when the user states a like, dislike, or habit — about you, the interaction, or himself (favorite things, pet names, positions, interaction rules) — write it in that same turn; these facts must not wait for a checkpoint. " +
	"Also evaluate maintenance at milestone endings: a confirmed decision, a reusable lesson, a correction, or a stable access fact each deserves its write in that same turn. " +
	"Never defer a worthy write to wait for a checkpoint, and never pad extra writes just because one is due. " +
	"The tenth-query checkpoint is only a floor, not a schedule: every tenth user query of this session the harness appends a <checkpoint> block naming memory, and on a marked query, before finishing your reply, first read the `memory-hygiene` skill's SKILL.md (its path is in <available_skills>) with the read tool, then follow it and call memory_write at least once — even if nothing seems important, record the session's stage. " +
	"A skipped checkpoint stays owed: the flag re-appears on every following query until a write succeeds.";

/** Distinct visible user queries on this session's branch, from the shared query ledger. */
function sessionQueryCount(entries: readonly SessionEntry[], sessionId: string): number {
	const sources = new Map<string, { queryId?: string; internal?: boolean; sessionId?: string }>();
	for (const entry of entries) {
		if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
		if (entry.customType === CONTINUITY_QUERY_ENTRY) {
			const data = entry.data as { entryId?: string; queryId?: string; internal?: boolean; sessionId?: string };
			if (typeof data.entryId === "string") sources.set(data.entryId, data);
		}
	}
	const queries = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const source = sources.get(entry.id);
		if (!source?.internal && (!source?.sessionId || source.sessionId === sessionId))
			queries.add(source?.queryId ?? entry.id);
	}
	return queries.size;
}

/** Distinct visible user queries on this session's branch, from the shared query ledger. */
export function continuityQueryCount(manager: ReadonlySessionManager): number {
	return sessionQueryCount(manager.getBranch(), manager.getSessionId());
}

/**
 * True when the user query about to be answered is an exact tenth. This is
 * the only continuity cadence trigger: a non-owing reminder on that query
 * alone — no debt entry, no replay on later queries when it is skipped.
 */
export function continuityReminderDue(manager: ReadonlySessionManager): boolean {
	return (continuityQueryCount(manager) + 1) % CONTINUITY_REMINDER_INTERVAL === 0;
}

/** Recall questions mention memory but only ask for retrieval — they never trigger the hint. */
const MEMORY_RECALL_QUESTION =
	/记不记得|记得(吗|吧|么|没有)|是否记得|还想得起|想起来了|(do|did)\s+you\s+remember|you\s+remember/i;
/** Imperative memory cues: the user asks that something be kept for later. */
const MEMORY_IMPERATIVE_CUE =
	/记住|记下|别忘了|不要忘记|不可忘记|牢牢地?记|下次|以后|今后|往后|remember\s+(this|that|to|it|the|a|everything|what)|don'?t\s+forget|does\s+not\s+forget|keep\s+(this|that|it)\s+in\s+mind|from\s+now\s+on|next\s+time|make\s+a\s+note|write\s+(this|that|it)\s+down/i;

/**
 * Hint for user messages that imperatively ask the assistant to keep
 * something for later. Recall questions ("你还记得吗", "do you remember")
 * are excluded: they ask the model to retrieve, not to store. The returned
 * text only asks the model to evaluate a write; it is never an order.
 */
export function memoryHintFor(text: string): string | undefined {
	if (!text.trim()) return undefined;
	if (MEMORY_RECALL_QUESTION.test(text)) return undefined;
	if (!MEMORY_IMPERATIVE_CUE.test(text)) return undefined;
	return (
		"The user's message may be a request to keep something for later. " +
		"Please consider whether it warrants a durable write this turn — memory_write for a fact, preference, or lesson; continuity_update for a stage change. " +
		"This hint only asks you to evaluate; it is not an order to write."
	);
}

/**
 * Memory floor, on a ten-query cadence over the same ledger: a successful
 * memory_write clears the current block; skipping keeps it owed. This debt
 * model is intentional and applies to memory only — continuity has none.
 */
export function memoryUpdateCadence(manager: ReadonlySessionManager): {
	queries: number;
	block: number;
	due: boolean;
} {
	const entries = manager.getBranch();
	const sessionId = manager.getSessionId();
	let completed = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
		if (entry.customType === MEMORY_CHECKPOINT_ENTRY) {
			const data = entry.data as { block?: number; sessionId?: string };
			if (data.sessionId === sessionId && typeof data.block === "number" && Number.isInteger(data.block)) {
				completed = Math.max(completed, data.block);
			}
		}
	}
	const queries = sessionQueryCount(entries, sessionId);
	const block = Math.floor(queries / MEMORY_UPDATE_INTERVAL);
	return { queries, block, due: block > completed };
}
