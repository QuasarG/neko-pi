/**
 * `todo_write`: a session-scoped checklist for multi-step work.
 *
 * The model plans a complex task as items BEFORE starting, then updates the
 * list as it goes — one item in_progress at a time, completed marked in the
 * same turn as the finishing action. State is in-memory per session (a fresh
 * session starts fresh); deliverables never live here, only progress.
 *
 * The discipline is prompt-carried (tool description + system-prompt
 * guideline): there is no checkpoint, no debt, no harness nagging — the list
 * is visible in the transcript and in the above-editor widget, and keeping it
 * current is the model's own habit to follow.
 */

import type { Component } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { ensureSystemToolsActive } from "../system-tool-repair.ts";
import { TodoPanelComponent } from "./panel.ts";

export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
}

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

/** Trim, drop empties, cap the length: a list longer than this is a plan, not a todo. */
export function normalizeItems(items: TodoItem[]): TodoItem[] {
	return items
		.map((item) => ({ content: item.content.replace(/\s+/g, " ").trim(), status: item.status }))
		.filter((item) => item.content.length > 0)
		.slice(0, 30)
		.map((item) => ({ ...item, content: item.content.slice(0, 200) }));
}

const STATUS_MARK: Record<TodoItem["status"], string> = {
	pending: "○",
	in_progress: "▸",
	completed: "✓",
};

/** One line per item, in_progress first-ish: the natural reading order is kept. */
export function renderTodoLines(items: TodoItem[]): string[] {
	const done = items.filter((item) => item.status === "completed").length;
	return [`待办 ${done}/${items.length}`, ...items.map((item) => `  ${STATUS_MARK[item.status]} ${item.content}`)];
}

/** Pure state step: replace the list, or clear it once everything is done. */
export function nextTodoState(previous: TodoItem[], incoming: TodoItem[]): TodoItem[] | undefined {
	const items = normalizeItems(incoming);
	if (items.length === 0) return undefined;
	if (items.every((item) => item.status === "completed") && previous.length > 0 && items.length === previous.length) {
		// All done and the shape matches the plan: the checklist retires.
		return undefined;
	}
	return items;
}

class TodoResultComponent extends Container {
	constructor(theme: Theme, items: TodoItem[]) {
		super();
		for (const line of renderTodoLines(items)) {
			const isHeader = !line.startsWith("  ");
			const mark = line.trim().slice(0, 1);
			const color = isHeader ? "accent" : mark === "✓" ? "dim" : mark === "▸" ? "accent" : "muted";
			this.addChild(new Text(theme.fg(color as "accent" | "dim" | "muted", line), 1, 0));
		}
	}
	invalidate(): void {
		// Lines are fixed at construction; nothing to invalidate.
	}
}

const todoExtension: ExtensionFactory = (pi) => {
	const lists = new Map<string, TodoItem[]>();

	const currentList = (sessionId: string | undefined): TodoItem[] =>
		(sessionId ? lists.get(sessionId) : undefined) ?? [];

	// The live panel above the editor: created with the widget, dropped when
	// the checklist retires.
	let panel: TodoPanelComponent | undefined;
	let panelSession: string | undefined;

	const syncWidget = (
		ctx: { mode: string; ui: { setWidget(key: string, content: unknown, options?: { placement?: string }): void } },
		sessionId: string,
	): void => {
		const items = currentList(sessionId);
		try {
			if (items.length === 0) {
				// The checklist retired (everything completed): remove the
				// panel for good — /todo cannot bring the finished list back.
				panel = undefined;
				panelSession = undefined;
				ctx.ui.setWidget("todo", undefined, { placement: "aboveEditor" });
				return;
			}
			if (panel && panelSession === sessionId) return; // the live panel re-renders itself
			if (ctx.mode === "tui") {
				ctx.ui.setWidget(
					"todo",
					(tui: object, theme: Theme) => {
						const component = new TodoPanelComponent(
							theme,
							() => currentList(panelSession),
							() => (tui as { requestRender(): void }).requestRender(),
						);
						panel = component;
						return component;
					},
					{ placement: "aboveEditor" },
				);
				panelSession = sessionId;
			} else {
				// Headless hosts take plain lines; no panel object to manage.
				ctx.ui.setWidget("todo", renderTodoLines(items), { placement: "aboveEditor" });
			}
		} catch {
			// Headless contexts have no widget sink; the transcript still records.
		}
	};

	pi.registerTool({
		name: "todo_write",
		label: "todo_write",
		description:
			"Maintain the session's todo checklist. Pass the FULL list every call (it replaces the previous one): items with content and status pending/in_progress/completed. " +
			"Use it for any task with three or more distinct steps: write the plan BEFORE starting work, keep exactly one item in_progress at a time, and mark an item completed in the same turn as the action that finishes it — then set the next one in_progress. " +
			"When everything is done, send the final all-completed list once; the checklist then retires. " +
			"Do not use it for trivial or single-step work, and never store deliverables here: the list tracks progress only and dies with the session.",
		promptSnippet: "todo_write(items[]) - plan multi-step work as a checklist and keep its statuses current",
		promptGuidelines: [
			"For a task with three or more distinct steps, draft the checklist with todo_write before starting, and update it as you go — one item in_progress at a time, completions marked immediately.",
		],
		parameters: Type.Object({
			items: Type.Array(
				Type.Object({
					content: Type.String({ description: "One concrete step, a few words" }),
					status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
				}),
				{ minItems: 1, maxItems: 30, description: "The full checklist; each call replaces the previous list" },
			),
		}),
		renderCall: (args, theme: Theme) =>
			new TodoResultComponent(theme, normalizeItems(args.items as TodoItem[])) as unknown as Component,
		renderResult: (result, _options, theme: Theme) =>
			new TodoResultComponent(
				theme,
				(result.details as { items?: TodoItem[] } | undefined)?.items ?? [],
			) as unknown as Component,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			const previous = currentList(sessionId);
			const next = nextTodoState(previous, params.items as TodoItem[]);
			if (next === undefined) lists.delete(sessionId);
			else lists.set(sessionId, next);
			syncWidget(ctx, sessionId ?? "");
			return {
				content: [{ type: "text", text: renderTodoLines(next ?? previous).join("\n") }],
				details: { items: next ?? [] },
			};
		},
	});

	pi.registerCommand("todo", {
		description: "展开/收起输入框上方的待办列表",
		handler: async (_args, ctx) => {
			if (!panel) {
				ctx.ui.notify("当前没有进行中的待办列表", "info");
				return;
			}
			panel.toggle();
		},
	});

	// A transcript frozen while todo_write was absent keeps it inactive in
	// every later process; ensure it on every run so planning cannot die.
	pi.on("before_agent_start", () => {
		ensureSystemToolsActive(pi, ["todo_write"]);
	});

	pi.on("session_start", (_event, ctx) => {
		// A fresh session starts with a clean slate and no leftover widget.
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId) lists.delete(sessionId);
		panel = undefined;
		panelSession = undefined;
		syncWidget(ctx, sessionId ?? "");
	});
};

export default todoExtension;
