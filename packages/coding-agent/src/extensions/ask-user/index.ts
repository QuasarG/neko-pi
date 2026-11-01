/**
 * `ask_user`: let the model put a multiple-choice question to the user.
 *
 * Two delivery modes, chosen by the model per question:
 *
 * - Foreground (default): the turn pauses on the tool call and a question
 *   dialog takes the editor slot; the user's choice is the tool result.
 * - Background (`background: true`): the tool returns immediately, the model
 *   keeps working on its stated assumption, and the dialog pops when the
 *   current turn ends. An actual answer is delivered as an automated custom
 *   message with `triggerTurn` — the same end-appended turn channel as
 *   background-job notifications — so the model wakes with the decision.
 *
 * Both modes share a 3-minute timeout: an unanswered question is skipped, the
 * dialog closes, and the model is told to proceed on its best judgment.
 * Timeouts and dismissals in background mode send nothing (the model already
 * proceeded); only real answers wake it.
 */

import { Type } from "typebox";
import type { ExtensionFactory, ExtensionUIContext } from "../../core/extensions/types.ts";
import { ensureSystemToolsActive } from "../system-tool-repair.ts";
import { type AskUserAnswer, type AskUserOption, type AskUserQuestion, QuestionDialog } from "./dialog.ts";

const MAX_HEADER_LENGTH = 40;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

/** Base lifetime of a question, foreground and background alike. */
export const QUESTION_TIMEOUT_MS = 180_000;

/** Marker for an answer delivered asynchronously — it IS from the user. */
const ANSWER_PREAMBLE =
	"[USER ANSWER - delivered asynchronously]\n" +
	"The user answered a question you asked earlier. This answer IS from the user.\n";

export function normalizeOptions(options: AskUserOption[]): AskUserOption[] {
	const seen = new Set<string>();
	const result: AskUserOption[] = [];
	for (const option of options) {
		const label = option.label.trim();
		if (label.length === 0) continue;
		const key = label.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const description = option.description?.trim();
		result.push({ label, ...(description ? { description } : {}) });
	}
	return result;
}

/** Render the answer as the text the model reads back (foreground tool result). */
export function formatAnswer(answer: AskUserAnswer): string {
	if (answer.freeText) return `The user answered: ${answer.freeText}`;
	if (answer.labels.length === 0) return "The user did not pick any option.";
	return `The user chose: ${answer.labels.join(", ")}`;
}

/** Render the answer notification for a background question. */
export function formatAnswerNotification(question: AskUserQuestion, answer: AskUserAnswer): string {
	const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const chosen = answer.freeText ?? answer.labels.join(", ");
	return [
		ANSWER_PREAMBLE,
		"<question_answer>",
		`  <question>${escapeXml(question.question)}</question>`,
		`  <answer>${escapeXml(chosen)}</answer>`,
		"</question_answer>",
	].join("\n");
}

interface PendingQuestion {
	id: number;
	question: AskUserQuestion;
	askedAt: number;
	/** Fires when the question's lifetime is up. */
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Decode a host's picked strings into an answer: offered labels keep their
 * offered order (the TUI dialog's rule), a string that is not an offered
 * label is a free-text answer, and an empty pick set is no answer at all —
 * the UI must not offer a submit for it.
 */
const answerFromPicks = (picks: string[], labels: string[]): AskUserAnswer | undefined => {
	const freeText = picks.find((pick) => !labels.includes(pick));
	if (freeText !== undefined) return { labels: [], freeText };
	const picked = labels.filter((label) => picks.includes(label));
	return picked.length > 0 ? { labels: picked } : undefined;
};

const askUserExtension: ExtensionFactory = (pi) => {
	// A transcript frozen while ask_user was absent keeps it inactive in every
	// later process; ensure it on every run so the model can always ask.
	pi.on("before_agent_start", () => {
		ensureSystemToolsActive(pi, ["ask_user"]);
	});

	// Background delivery state. Process-wide, like the background-jobs
	// registry: questions outlive the tool call that asked them.
	let pending: PendingQuestion[] = [];
	let nextId = 0;
	let ui: ExtensionUIContext | undefined;
	let uiMode: "tui" | "rpc" | "json" | "print" = "print";
	let dialogBusy = false;

	const refreshStatus = (): void => {
		try {
			ui?.setStatus(
				"ask-user",
				pending.length > 0 ? `${pending.length} question${pending.length > 1 ? "s" : ""} pending` : undefined,
			);
		} catch {
			// A stale headless ctx can throw; the registry state stays correct.
		}
	};

	const dropPending = (entry: PendingQuestion): void => {
		clearTimeout(entry.timer);
		pending = pending.filter((candidate) => candidate !== entry);
		refreshStatus();
	};

	const deliverAnswer = (entry: PendingQuestion, answer: AskUserAnswer): void => {
		try {
			pi.sendMessage(
				{
					customType: "ask-user-answer",
					content: formatAnswerNotification(entry.question, answer),
					display: true,
					details: {
						questionId: entry.id,
						labels: answer.labels,
						...(answer.freeText ? { freeText: answer.freeText } : {}),
					},
				},
				{ triggerTurn: true },
			);
		} catch {
			// Headless runs have no live session to deliver to.
		}
	};

	/** Show the question dialog; resolves with the answer, or undefined on skip. */
	const askThroughUI = async (
		uiCtx: ExtensionUIContext,
		mode: "tui" | "rpc" | "json" | "print",
		question: AskUserQuestion,
		remainingMs: number,
		signal?: AbortSignal,
	): Promise<AskUserAnswer | undefined> => {
		if (signal?.aborted) return undefined;
		if (mode === "tui") {
			return await uiCtx.custom<AskUserAnswer | undefined>((tui, theme, keybindings, done) => {
				const dialog = new QuestionDialog(theme, keybindings, question, (answer) => done(answer), {
					tui,
					timeoutMs: remainingMs,
				});
				signal?.addEventListener("abort", () => dialog.dismiss(), { once: true });
				return dialog;
			});
		}
		const labels = question.options.map((option) => option.label);
		const dialogOptions = { timeout: Math.max(1000, remainingMs), ...(signal ? { signal } : {}) };
		const title = question.header ? `${question.header}: ${question.question}` : question.question;
		// Multi-select needs a host that can answer with an array; hosts without
		// selectMultiple get a single-choice select (one label, not a fake join).
		let picks: string[] | undefined;
		if (question.multiSelect && uiCtx.selectMultiple) {
			picks = await uiCtx.selectMultiple(title, labels, dialogOptions);
		} else {
			const picked = await uiCtx.select(title, labels, dialogOptions);
			picks = picked === undefined ? undefined : [picked];
		}
		return picks === undefined ? undefined : answerFromPicks(picks, labels);
	};

	/** Pop the oldest still-live background question into the dialog. */
	const popNext = (): void => {
		if (dialogBusy || !ui || uiMode === "print" || uiMode === "json" || pending.length === 0) return;
		const entry = pending[0]!;
		const remainingMs = QUESTION_TIMEOUT_MS - (Date.now() - entry.askedAt);
		if (remainingMs <= 0) {
			dropPending(entry);
			return;
		}
		dialogBusy = true;
		void askThroughUI(ui, uiMode, entry.question, remainingMs).then((answer) => {
			dialogBusy = false;
			dropPending(entry);
			if (answer && (answer.labels.length > 0 || answer.freeText)) deliverAnswer(entry, answer);
			else ui?.notify("Question skipped — not answered", "info");
			// Answering one question frees the slot for the next.
			popNext();
		});
	};

	pi.registerTool({
		name: "ask_user",
		label: "ask_user",
		description:
			"Ask the user a multiple-choice question. Use it only when the next step depends on a decision you cannot make yourself " +
			"(a product or design choice, which of two valid approaches to take, a missing credential the user must supply). " +
			"Offer 2-4 mutually exclusive options with a one-line description each; the user can always type a free-text answer instead. " +
			"Do not use it for questions the repository, the code, or the tool output can answer.\n" +
			`Blocking vs background: default (blocking) pauses this turn until the user answers — use it when you cannot sensibly continue without the answer. ` +
			"Set background=true when the answer is useful but not required: the tool returns immediately, you keep working on a stated assumption, the user answers when free, and the answer arrives as a follow-up message. " +
			`Either way the question expires after ${Math.round(QUESTION_TIMEOUT_MS / 1000)} seconds unanswered; proceed with your best judgment then.`,
		promptSnippet:
			"ask_user(question, options[]) - ask the user to pick between a few options and wait for the answer",
		promptGuidelines: [
			"Decide for yourself whenever you can; ask_user is for decisions only the user can make, not for things the code or tools can tell you.",
		],
		parameters: Type.Object({
			question: Type.String({
				description: "The question to ask, in one or two sentences. Say what decision is at stake.",
			}),
			header: Type.Optional(
				Type.String({
					description: `Short title for the question dialog, up to ${MAX_HEADER_LENGTH} characters`,
				}),
			),
			options: Type.Array(
				Type.Object({
					label: Type.String({ description: "The option text, a few words at most" }),
					description: Type.Optional(Type.String({ description: "One short line on what this option means" })),
				}),
				{
					minItems: MIN_OPTIONS,
					maxItems: MAX_OPTIONS,
					description: "The choices to offer, mutually exclusive",
				},
			),
			multi_select: Type.Optional(
				Type.Boolean({ description: "Set to true when the user may pick several options at once" }),
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"true = do not wait: keep working on a stated assumption; the answer arrives later as a follow-up message",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: `No interactive UI in ${ctx.mode} mode, so nobody can answer a question. Ask the user in plain text instead.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const options = normalizeOptions(params.options);
			if (options.length < MIN_OPTIONS) {
				return {
					content: [
						{
							type: "text",
							text: `ask_user needs at least ${MIN_OPTIONS} distinct options, got ${options.length}.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const question: AskUserQuestion = {
				question: params.question.trim(),
				...(params.header?.trim() ? { header: params.header.trim().slice(0, MAX_HEADER_LENGTH) } : {}),
				options,
				multiSelect: params.multi_select === true,
			};

			if (params.background === true) {
				nextId += 1;
				const entry: PendingQuestion = {
					id: nextId,
					question,
					askedAt: Date.now(),
					timer: setTimeout(() => {
						// Skipped, not answered: no wake, the model already proceeded.
						// A dialog still showing this question expires on its own
						// countdown and resolves the same way.
						dropPending(entry);
						try {
							ui?.notify("Background question expired unanswered", "info");
						} catch {
							// Stale ctx in headless runs.
						}
					}, QUESTION_TIMEOUT_MS),
				};
				pending.push(entry);
				refreshStatus();
				return {
					content: [
						{
							type: "text",
							text:
								`Question queued for the user (expires in ${Math.round(QUESTION_TIMEOUT_MS / 1000)}s). ` +
								"Continue working and state the assumption you proceeded on; if the user answers, the answer arrives as a follow-up message. " +
								"If it expires unanswered, nothing is sent — your assumption stands unless the user says otherwise.",
						},
					],
					details: { background: true, questionId: entry.id },
				};
			}

			// Foreground: the turn waits here for the answer (or the timeout).
			const answer = await askThroughUI(ctx.ui, ctx.mode, question, QUESTION_TIMEOUT_MS, signal);
			if (!answer) {
				return {
					content: [
						{
							type: "text",
							text:
								`The user did not answer (dismissed or ${Math.round(QUESTION_TIMEOUT_MS / 1000)}s timeout). ` +
								"Proceed with your best judgment and state the assumption you made.",
						},
					],
					details: { answered: false },
				};
			}
			return {
				content: [{ type: "text", text: formatAnswer(answer) }],
				details: { answered: true, ...answer },
			};
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		uiMode = ctx.mode;
		refreshStatus();
	});

	// The background dialog pops when the turn that asked it has finished —
	// by then the editor is free and the user is (usually) looking.
	pi.on("agent_end", () => {
		popNext();
	});
};

export default askUserExtension;
