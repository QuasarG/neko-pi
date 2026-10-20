import type { Component } from "@earendil-works/pi-tui";

/**
 * Prefixes every rendered line with a colored vertical bar, replicating the
 * single-edge left border opencode draws around user messages, thinking
 * blocks, and the composer. The bar renders on blank lines too, so the
 * border reads as one continuous column.
 */
export class LeftBar implements Component {
	private readonly child: Component;
	private readonly bar: string;

	constructor(child: Component, bar: string) {
		this.child = child;
		this.bar = bar;
	}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		return this.child.render(Math.max(1, width - 1)).map((line) => this.bar + line);
	}
}
