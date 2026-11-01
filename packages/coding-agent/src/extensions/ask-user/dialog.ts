/**
 * The question dialog behind the `ask_user` tool.
 *
 * The component takes over the editor slot while the agent turn is paused on
 * the tool call, so the user answers a multiple-choice question without
 * leaving the chat. It supports single and multi selection, one-line option
 * descriptions, and a free-text "Other" entry for answers that are none of the
 * offered options.
 */

import { Container, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { CountdownTimer } from "../../modes/interactive/components/countdown-timer.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { keyHint, rawKeyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

export interface AskUserOption {
	/** The option text as the model wrote it. */
	label: string;
	/** One short line explaining what picking it means. */
	description?: string;
}

export interface AskUserQuestion {
	/** The question to ask. */
	question: string;
	/** Short title shown above the question. */
	header?: string;
	/** The offered options. */
	options: AskUserOption[];
	/** Whether the user may pick more than one option. */
	multiSelect: boolean;
}

export interface AskUserAnswer {
	/** Labels of the picked options, in the order they were offered. */
	labels: string[];
	/** Free-text answer, when the user chose "Other". */
	freeText?: string;
}

/** Label of the trailing free-text entry. */
export const OTHER_OPTION_LABEL = "Other — type your own answer";

const MIN_OPTION_WIDTH = 24;

/** Wrap text to the given visible width, breaking on spaces. */
export function wrapText(text: string, width: number): string[] {
	const limit = Math.max(MIN_OPTION_WIDTH, width);
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph.trim().length === 0) {
			lines.push("");
			continue;
		}
		let current = "";
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			if (current.length === 0) {
				current = word;
			} else if (current.length + 1 + word.length <= limit) {
				current += ` ${word}`;
			} else {
				lines.push(current);
				current = word;
			}
		}
		if (current.length > 0) lines.push(current);
	}
	return lines;
}

export interface QuestionDialogOptions {
	/** TUI for countdown re-renders; without it no countdown is shown. */
	tui?: TUI;
	/** Time left to answer, in ms. Expiring resolves the dialog unanswered. */
	timeoutMs?: number;
}

export class QuestionDialog extends Container {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly question: AskUserQuestion;
	private readonly onAnswer: (answer: AskUserAnswer | undefined) => void;
	private readonly choices: AskUserOption[];
	private readonly checked = new Set<number>();
	private readonly countdown: CountdownTimer | undefined;
	private selectedIndex = 0;
	private typing = false;
	private input: Input | undefined;
	private settled = false;
	private timeLeftLabel = "";

	constructor(
		theme: Theme,
		keybindings: KeybindingsManager,
		question: AskUserQuestion,
		onAnswer: (answer: AskUserAnswer | undefined) => void,
		options?: QuestionDialogOptions,
	) {
		super();
		this.theme = theme;
		this.keybindings = keybindings;
		this.question = question;
		this.onAnswer = onAnswer;
		this.choices = [...question.options, { label: OTHER_OPTION_LABEL, description: "Answer in your own words" }];
		if (options?.tui !== undefined && options.timeoutMs !== undefined && options.timeoutMs > 0) {
			this.countdown = new CountdownTimer(
				options.timeoutMs,
				options.tui,
				(seconds) => {
					this.timeLeftLabel = seconds > 0 ? ` (${seconds}s)` : "";
					this.rebuild();
				},
				() => this.finish(undefined),
			);
		}
		this.rebuild();
	}

	/** Close the dialog unanswered (timeout, external abort). */
	dismiss(): void {
		this.finish(undefined);
	}

	dispose(): void {
		this.countdown?.dispose();
	}

	private finish(answer: AskUserAnswer | undefined): void {
		if (this.settled) return;
		this.settled = true;
		this.onAnswer(answer);
	}

	private toggle(index: number): void {
		if (this.checked.has(index)) this.checked.delete(index);
		else this.checked.add(index);
		this.rebuild();
	}

	/** Confirm the highlighted entry: pick it (single) or toggle it (multi). */
	private choose(index: number): void {
		if (index === this.choices.length - 1) {
			this.startTyping();
			return;
		}
		if (this.question.multiSelect) {
			this.toggle(index);
			return;
		}
		this.finish({ labels: [this.choices[index]!.label] });
	}

	/** Confirm the current selection set. */
	private confirm(): void {
		if (!this.question.multiSelect) {
			this.choose(this.selectedIndex);
			return;
		}
		if (this.checked.size === 0) {
			// Nothing ticked yet: confirm the highlighted option so enter always does something.
			this.finish({ labels: [this.choices[this.selectedIndex]!.label] });
			return;
		}
		const labels = this.choices.filter((_, index) => this.checked.has(index)).map((choice) => choice.label);
		this.finish({ labels });
	}

	private startTyping(): void {
		this.typing = true;
		const input = new Input({ prompt: "> " });
		input.onSubmit = (value) => {
			const trimmed = value.trim();
			if (trimmed.length === 0) {
				this.typing = false;
				this.input = undefined;
				this.rebuild();
				return;
			}
			this.finish({ labels: [], freeText: trimmed });
		};
		input.onEscape = () => {
			this.typing = false;
			this.input = undefined;
			this.rebuild();
		};
		this.input = input;
		this.rebuild();
	}

	private move(delta: number): void {
		const next = this.selectedIndex + delta;
		if (next < 0 || next >= this.choices.length) return;
		this.selectedIndex = next;
		this.rebuild();
	}

	handleInput(data: string): void {
		if (this.settled) return;
		if (this.typing) {
			this.input?.handleInput(data);
			return;
		}
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			this.finish(undefined);
			return;
		}
		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.move(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			this.move(1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			this.confirm();
			return;
		}
		if (data === " ") {
			this.choose(this.selectedIndex);
			return;
		}
		if (/^[1-9]$/.test(data)) {
			const index = Number(data) - 1;
			if (index < this.choices.length) {
				this.selectedIndex = index;
				this.choose(index);
			}
		}
	}

	private hintText(): string {
		if (this.typing) return `${rawKeyHint("enter", "submit")}  ${keyHint("tui.select.cancel", "back")}`;
		const toggle = this.question.multiSelect ? `${rawKeyHint("space", "toggle")}  ` : "";
		return (
			`${rawKeyHint("↑↓", "navigate")}  ${rawKeyHint("1-9", "pick")}  ${toggle}` +
			`${keyHint("tui.select.confirm", "confirm")}  ${keyHint("tui.select.cancel", "cancel")}`
		);
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
		this.addChild(
			new Text(
				this.theme.fg("accent", this.theme.bold(`${this.question.header ?? "Question"}${this.timeLeftLabel}`)),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		for (const line of wrapText(this.question.question, 80)) {
			this.addChild(new Text(this.theme.fg("text", line), 1, 0));
		}
		this.addChild(new Spacer(1));

		if (this.typing) {
			this.addChild(new Text(this.theme.fg("muted", "Type your answer:"), 1, 0));
			if (this.input) this.addChild(this.input);
		} else {
			const indent = this.question.multiSelect ? 9 : 5;
			this.choices.forEach((choice, index) => {
				const isCursor = index === this.selectedIndex;
				const marker = this.question.multiSelect ? (this.checked.has(index) ? "[x] " : "[ ] ") : "";
				const cursor = isCursor ? "→ " : "  ";
				const label = isCursor ? this.theme.fg("accent", choice.label) : this.theme.fg("text", choice.label);
				this.addChild(new Text(`${cursor}${marker}${index + 1}) ${label}`, 1, 0));
				if (choice.description) {
					this.addChild(new Text(this.theme.fg("muted", choice.description), indent, 0));
				}
			});
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("dim", this.hintText()), 1, 0));
		this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
	}
}
