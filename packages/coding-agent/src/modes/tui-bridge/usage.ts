/** Aggregate only recorded assistant usage; metadata distinguishes missing history. */
export function projectedUsage(history: Array<Record<string, unknown>>) {
	const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
	let cost = 0;
	let recorded = 0;
	let missing = 0;
	for (const message of history) {
		if (message.type !== "assistant") continue;
		const usage = message.tokens as typeof tokens | undefined;
		if (
			!usage ||
			![usage.input, usage.output, usage.reasoning, usage.cache?.read, usage.cache?.write, message.cost].every(
				(value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
			)
		) {
			missing++;
			continue;
		}
		recorded++;
		tokens.input += usage.input;
		tokens.output += usage.output;
		tokens.reasoning += usage.reasoning;
		tokens.cache.read += usage.cache.read;
		tokens.cache.write += usage.cache.write;
		cost += message.cost as number;
	}
	return {
		cost,
		tokens,
		metadata: {
			usage: {
				source: recorded === 0 && missing > 0 ? "unknown" : missing > 0 ? "partial" : "recorded",
				recordedMessages: recorded,
				missingMessages: missing,
				costSource: "model-price-estimate",
				reasoningSource: "included-in-output",
			},
		},
	};
}
