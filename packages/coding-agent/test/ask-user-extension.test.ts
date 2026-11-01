import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type AskUserAnswer,
	type AskUserQuestion,
	OTHER_OPTION_LABEL,
	QuestionDialog,
	wrapText,
} from "../src/extensions/ask-user/dialog.ts";
import {
	formatAnswer,
	formatAnswerNotification,
	normalizeOptions,
	QUESTION_TIMEOUT_MS,
} from "../src/extensions/ask-user/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

afterEach(() => {
	vi.useRealTimers();
});

const baseQuestion = (overrides: Partial<AskUserQuestion> = {}): AskUserQuestion => ({
	question: "Which database should the import target?",
	header: "Database",
	options: [
		{ label: "Postgres", description: "production data" },
		{ label: "SQLite", description: "local file" },
		{ label: "Skip import", description: "leave the data out" },
	],
	multiSelect: false,
	...overrides,
});

function buildDialog(
	question: AskUserQuestion,
	onAnswer: (answer: AskUserAnswer | undefined) => void,
	options?: { tui?: TUI; timeoutMs?: number },
): QuestionDialog {
	return new QuestionDialog(theme, new KeybindingsManager(), question, onAnswer, options);
}

describe("wrapText", () => {
	test("wraps long lines at spaces and keeps explicit newlines", () => {
		// The wrap floor is 24 columns, so both of these wrap at 24, not the requested width.
		expect(wrapText("alpha beta gamma delta epsilon", 10)).toEqual(["alpha beta gamma delta", "epsilon"]);
		expect(wrapText("one\ntwo", 40)).toEqual(["one", "two"]);
	});

	test("never wraps below the floor width", () => {
		const lines = wrapText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 5);
		expect(lines).toEqual(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
	});
});

describe("normalizeOptions", () => {
	test("trims, drops empties, and dedupes case-insensitively", () => {
		expect(
			normalizeOptions([
				{ label: " Postgres ", description: " prod " },
				{ label: "postgres" },
				{ label: "   " },
				{ label: "SQLite" },
			]),
		).toEqual([{ label: "Postgres", description: "prod" }, { label: "SQLite" }]);
	});
});

describe("formatAnswer / formatAnswerNotification", () => {
	test("foreground result text", () => {
		expect(formatAnswer({ labels: ["Postgres"] })).toBe("The user chose: Postgres");
		expect(formatAnswer({ labels: ["A", "B"] })).toBe("The user chose: A, B");
		expect(formatAnswer({ labels: [], freeText: "use Redis" })).toBe("The user answered: use Redis");
		expect(formatAnswer({ labels: [] })).toBe("The user did not pick any option.");
	});

	test("notification carries the original question, the answer, and XML escaping", () => {
		const text = formatAnswerNotification(baseQuestion({ question: "keep <prod> & dev?" }), {
			labels: [],
			freeText: "yes <please> &",
		});
		expect(text).toContain("IS from the user");
		expect(text).toContain("<question>keep &lt;prod&gt; &amp; dev?</question>");
		expect(text).toContain("<answer>yes &lt;please&gt; &amp;</answer>");
		expect(text).toContain("<question_answer>");
	});
});

describe("QuestionDialog", () => {
	test("renders header, question, numbered options, and the Other row", () => {
		initTheme("dark");
		const dialog = buildDialog(baseQuestion(), () => {});
		const rendered = stripAnsi(dialog.render(100).join("\n"));
		expect(rendered).toContain("Database");
		expect(rendered).toContain("Which database should the import target?");
		expect(rendered).toContain("1) Postgres");
		expect(rendered).toContain("2) SQLite");
		expect(rendered).toContain("4) Other");
		expect(rendered).toContain("production data");
		expect(rendered).toContain("cancel");
	});

	test("a digit key picks that option in single-select mode", () => {
		initTheme("dark");
		const answers: Array<AskUserAnswer | undefined> = [];
		const dialog = buildDialog(baseQuestion(), (answer) => answers.push(answer));
		dialog.handleInput("2");
		expect(answers).toEqual([{ labels: ["SQLite"] }]);
		// Settled dialogs swallow further input.
		dialog.handleInput("1");
		expect(answers).toHaveLength(1);
	});

	test("enter picks the highlighted option", () => {
		initTheme("dark");
		const answers: Array<AskUserAnswer | undefined> = [];
		const dialog = buildDialog(baseQuestion(), (answer) => answers.push(answer));
		dialog.handleInput("\x1b[B"); // down
		dialog.handleInput("\r");
		expect(answers).toEqual([{ labels: ["SQLite"] }]);
	});

	test("space toggles and enter submits the ticked set in multi-select mode", () => {
		initTheme("dark");
		const answers: Array<AskUserAnswer | undefined> = [];
		const dialog = buildDialog(baseQuestion({ multiSelect: true }), (answer) => answers.push(answer));
		dialog.handleInput(" "); // toggle Postgres
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\x1b[B");
		dialog.handleInput(" "); // toggle Skip import
		dialog.handleInput("\r");
		expect(answers).toEqual([{ labels: ["Postgres", "Skip import"] }]);
	});

	test("escape cancels without an answer", () => {
		initTheme("dark");
		const answers: Array<AskUserAnswer | undefined> = [];
		const dialog = buildDialog(baseQuestion(), (answer) => answers.push(answer));
		dialog.handleInput("\x1b");
		expect(answers).toEqual([undefined]);
	});

	test("Other takes free text, and empty text returns to the list", () => {
		initTheme("dark");
		const answers: Array<AskUserAnswer | undefined> = [];
		const dialog = buildDialog(baseQuestion(), (answer) => answers.push(answer));
		dialog.handleInput("4"); // Other
		for (const character of "use redis") dialog.handleInput(character);
		dialog.handleInput("\r");
		expect(answers).toEqual([{ labels: [], freeText: "use redis" }]);
	});

	test("empty Other submit stays on the dialog", () => {
		initTheme("dark");
		const answers: Array<AskUserAnswer | undefined> = [];
		const dialog = buildDialog(baseQuestion(), (answer) => answers.push(answer));
		dialog.handleInput("4");
		dialog.handleInput("\r"); // empty submit → back to the list
		expect(answers).toEqual([]);
		dialog.handleInput("1"); // still answerable
		expect(answers).toEqual([{ labels: ["Postgres"] }]);
	});

	test("the countdown expires the dialog unanswered", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const answers: Array<AskUserAnswer | undefined> = [];
		const tui = { requestRender: () => {} } as unknown as TUI;
		const dialog = buildDialog(baseQuestion(), (answer) => answers.push(answer), { tui, timeoutMs: 500 });
		expect(stripAnsi(dialog.render(100).join("\n"))).toContain("(1s)");
		vi.advanceTimersByTime(1100);
		expect(answers).toEqual([undefined]);
	});

	test("dismiss() closes externally without an answer", () => {
		initTheme("dark");
		const answers: Array<AskUserAnswer | undefined> = [];
		const dialog = buildDialog(baseQuestion(), (answer) => answers.push(answer));
		dialog.dismiss();
		dialog.dismiss();
		expect(answers).toEqual([undefined]);
	});

	test("the Other row is always last even in multi-select", () => {
		initTheme("dark");
		const dialog = buildDialog(baseQuestion({ multiSelect: true }), () => {});
		const rendered = stripAnsi(dialog.render(100).join("\n"));
		expect(rendered.indexOf(OTHER_OPTION_LABEL)).toBeGreaterThan(rendered.indexOf("3) Skip import"));
	});
});

describe("question lifetime", () => {
	test("the base timeout is three minutes", () => {
		expect(QUESTION_TIMEOUT_MS).toBe(180_000);
	});
});
