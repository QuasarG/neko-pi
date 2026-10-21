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
