/**
 * The above-editor todo panel: the session's checklist, in view while work
 * is in progress.
 *
 * The panel renders from a live list (a getter, not a snapshot), so tool
 * updates appear on the next render without rebuilding the widget. The user
 * collapses/expands it with /todo; long lists scroll with the mouse wheel.
 * When the model marks everything completed the extension removes the widget
 * entirely — the completed list cannot be summoned back.
 */

import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { TodoItem } from "./index.ts";

/** How many items the expanded panel shows before it starts scrolling. */
const MAX_VISIBLE_ITEMS = 8;

/** Braille spinner for the in-progress item: motion reads as "working on it". */
const PROGRESS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PROGRESS_FRAME_INTERVAL_MS = 120;

export class TodoPanelComponent implements Component {
	private readonly theme: Theme;
	private readonly getItems: () => TodoItem[];
	private readonly requestRender: () => void;
	private collapsed = false;
	private scrollTop = 0;
	private frameIndex = 0;
	private frameTimer: ReturnType<typeof setInterval> | undefined;

	constructor(theme: Theme, getItems: () => TodoItem[], requestRender: () => void) {
		this.theme = theme;
		this.getItems = getItems;
		this.requestRender = requestRender;
	}

	/** /todo: flip between the one-line header and the scrollable list. */
	toggle(): void {
		this.collapsed = !this.collapsed;
		this.clampScroll();
		this.requestRender();
	}

	private clampScroll(): void {
		const max = Math.max(0, this.getItems().length - MAX_VISIBLE_ITEMS);
		this.scrollTop = Math.min(this.scrollTop, max);
	}

	/** The animation runs only while some item is in progress (Loader pattern). */
	private syncAnimation(hasInProgress: boolean): void {
		if (hasInProgress && this.frameTimer === undefined) {
			this.frameTimer = setInterval(() => {
				this.frameIndex = (this.frameIndex + 1) % PROGRESS_FRAMES.length;
				this.requestRender();
			}, PROGRESS_FRAME_INTERVAL_MS);
		} else if (!hasInProgress && this.frameTimer !== undefined) {
			clearInterval(this.frameTimer);
			this.frameTimer = undefined;
		}
	}

	dispose(): void {
		if (this.frameTimer !== undefined) clearInterval(this.frameTimer);
	}

	handleMouse(event: TuiMouseEvent): { handled?: boolean } | undefined {
		if (event.type !== "wheel") return undefined;
		const lines = -Math.sign(event.wheelDelta ?? 0);
		if (lines === 0) return undefined;
		this.scrollTop = Math.max(0, this.scrollTop + lines);
		this.clampScroll();
		this.requestRender();
		return { handled: true };
	}

	render(_width: number): string[] {
		const items = this.getItems();
		const done = items.filter((item) => item.status === "completed").length;
		const hasInProgress = items.some((item) => item.status === "in_progress");
		this.syncAnimation(hasInProgress);
		const frame = PROGRESS_FRAMES[this.frameIndex] ?? "▸";
		const hint = this.collapsed ? " · /todo 展开" : " · /todo 收起";
		const headerMark = hasInProgress ? `${frame} ` : "";
		const lines = [this.theme.fg("accent", this.theme.bold(`${headerMark}待办 ${done}/${items.length}${hint}`))];
		if (!this.collapsed) {
			for (const item of items.slice(this.scrollTop, this.scrollTop + MAX_VISIBLE_ITEMS)) {
				const mark = item.status === "completed" ? "✓" : item.status === "in_progress" ? frame : "○";
				const color = item.status === "completed" ? "dim" : item.status === "in_progress" ? "accent" : "muted";
				lines.push(this.theme.fg(color as "dim" | "accent" | "muted", ` ${mark} ${item.content}`));
			}
			const hidden = items.length - MAX_VISIBLE_ITEMS - this.scrollTop;
			if (hidden > 0) lines.push(this.theme.fg("dim", `  · 还有 ${hidden} 项 · 滚轮翻看`));
		}
		return lines;
	}

	invalidate(): void {
		// State is read at render time from the live list; nothing to cache.
	}
}
