import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;
	private title?: string;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str), title?: string) {
		this.color = color;
		this.title = title;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lineWidth = Math.max(1, width);
		if (!this.title) {
			return [this.color("─".repeat(lineWidth))];
		}
		// Claude Code style: centered title embedded in the line, dimmed.
		const label = ` ${this.title} `;
		const labelWidth = visibleWidth(label);
		if (labelWidth + 2 > lineWidth) {
			return [this.color("─".repeat(lineWidth))];
		}
		const leftWidth = Math.floor((lineWidth - labelWidth) / 2);
		const rightWidth = lineWidth - leftWidth - labelWidth;
		return [this.color("─".repeat(leftWidth)) + theme.fg("dim", label) + this.color("─".repeat(rightWidth))];
	}
}
