import { describe, expect, test } from "vitest";
import { nextTodoState, normalizeItems, renderTodoLines, type TodoItem } from "../src/extensions/todo/index.ts";

const items = (list: Array<[string, TodoItem["status"]]>): TodoItem[] =>
	list.map(([content, status]) => ({ content, status }));

describe("normalizeItems", () => {
	test("trims, drops empties, caps length", () => {
		expect(
			normalizeItems([
				{ content: "  a  ", status: "pending" },
				{ content: "", status: "pending" },
			]),
		).toEqual([{ content: "a", status: "pending" }]);
		expect(
			normalizeItems(
				items([
					["a", "pending"],
					["b", "pending"],
					["c", "pending"],
				]),
			).length,
		).toBe(3);
	});
});

describe("renderTodoLines", () => {
	test("header counts completed and marks statuses", () => {
		const lines = renderTodoLines(
			items([
				["plan", "completed"],
				["build", "in_progress"],
				["verify", "pending"],
			]),
		);
		expect(lines[0]).toBe("待办 1/3");
		expect(lines[1]).toContain("✓ plan");
		expect(lines[2]).toContain("▸ build");
		expect(lines[3]).toContain("○ verify");
	});
});

describe("nextTodoState", () => {
	test("an empty list clears the state", () => {
		expect(nextTodoState(items([["a", "pending"]]), [])).toBeUndefined();
	});

	test("a normal update replaces the list", () => {
		const next = nextTodoState(
			items([["a", "completed"]]),
			items([
				["b", "in_progress"],
				["a", "completed"],
			]),
		);
		expect(next).toEqual(
			items([
				["b", "in_progress"],
				["a", "completed"],
			]),
		);
	});

	test("the final all-completed update retires the checklist", () => {
		const previous = items([
			["a", "in_progress"],
			["b", "pending"],
		]);
		expect(
			nextTodoState(
				previous,
				items([
					["a", "completed"],
					["b", "completed"],
				]),
			),
		).toBeUndefined();
	});

	test("all-completed without a matching prior shape still replaces (first call can be complete)", () => {
		expect(nextTodoState([], items([["only", "completed"]]))).toEqual(items([["only", "completed"]]));
	});
});
