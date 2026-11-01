/** UTF-8 bytes conservatively bound tokens without assuming a provider tokenizer. */
export function fitMemoryBudget(text: string, budget: number): string {
	let size = 0;
	let result = "";
	for (const character of text) {
		const bytes = Buffer.byteLength(character, "utf8");
		if (size + bytes > budget) break;
		result += character;
		size += bytes;
	}
	return result;
}

export const MEMORY_BUDGET = { continuity: 400, standing: 800, recall: 1800 } as const;

/**
 * Byte ceiling for one continuity summary. The reserve keeps room for the
 * store's own envelope, and the number is published to the model so a
 * summary that fits can be written in one attempt.
 */
export const CONTINUITY_SUMMARY_BUDGET = MEMORY_BUDGET.continuity - 100;
