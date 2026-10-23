import { expect, test } from "vitest";
import { projectedUsage } from "../src/modes/tui-bridge/usage.ts";

test("usage sums recorded assistant messages and identifies incomplete history", () => {
	const message = {
		type: "assistant",
		cost: 0.25,
		tokens: { input: 12, output: 3, reasoning: 0, cache: { read: 5, write: 2 } },
	};
	const result = projectedUsage([message, { type: "user" }, message]);
	expect(result.cost).toBe(0.5);
	expect(result.tokens).toEqual({ input: 24, output: 6, reasoning: 0, cache: { read: 10, write: 4 } });
	expect(result.metadata.usage.source).toBe("recorded");
	expect(projectedUsage([message, { type: "assistant" }]).metadata.usage.source).toBe("partial");
	expect(projectedUsage([{ type: "assistant", tokens: {}, cost: Number.NaN }]).metadata.usage.source).toBe("unknown");
});
