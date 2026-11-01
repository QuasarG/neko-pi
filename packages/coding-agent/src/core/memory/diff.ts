/**
 * Line diff for memory update delivery: a minimal edit script between the
 * previously delivered body and the current one, grouped as `- old` / `+ new`
 * regions. Pure and dependency-free; bodies split on \n only, so multi-byte
 * content (Chinese included) round-trips byte-exactly.
 */

export interface MemoryDiffLine {
	kind: "+" | "-";
	text: string;
}

/** Give up when the middle's LCS table would exceed this many cells. */
const CELL_GUARD = 4_000_000;
/** Give up when the rendered diff outweighs about half of the new body. */
const RENDER_RATIO = 0.5;

/** Shared edge trim: drop the common prefix and suffix lines. */
function trimEdges(oldLines: string[], newLines: string[]): { oldMiddle: string[]; newMiddle: string[] } {
	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
	let endOld = oldLines.length;
	let endNew = newLines.length;
	while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
		endOld--;
		endNew--;
	}
	return { oldMiddle: oldLines.slice(start, endOld), newMiddle: newLines.slice(start, endNew) };
}

/** Unguarded minimal diff: trim the common edges, LCS the middle. */
export function lineDiffRegions(oldBody: string, newBody: string): MemoryDiffLine[] {
	const { oldMiddle, newMiddle } = trimEdges(oldBody.split("\n"), newBody.split("\n"));
	return middleDiff(oldMiddle, newMiddle);
}

/**
 * Minimal line diff of two bodies, or null when a diff is not worth
 * rendering: the changed middle exceeds the cell guard, or the rendered
 * lines would exceed about half of the new body's bytes. Null means the
 * caller falls back to the full body.
 */
export function diffMemoryBodies(oldBody: string, newBody: string): MemoryDiffLine[] | null {
	const { oldMiddle, newMiddle } = trimEdges(oldBody.split("\n"), newBody.split("\n"));
	if (oldMiddle.length * newMiddle.length > CELL_GUARD) return null;
	const lines = middleDiff(oldMiddle, newMiddle);
	// "- " prefix plus the joining newline per rendered line; only the lines
	// decide economy.
	let renderedBytes = 0;
	for (const line of lines) renderedBytes += 3 + Buffer.byteLength(line.text);
	if (renderedBytes > RENDER_RATIO * Buffer.byteLength(newBody)) return null;
	return lines;
}

/** LCS over the guarded middle; the prefix and suffix were trimmed upstream. */
function middleDiff(oldLines: string[], newLines: string[]): MemoryDiffLine[] {
	const rows = oldLines.length;
	const cols = newLines.length;
	// lcs[i * (cols + 1) + j] = LCS length of oldLines[i..] and newLines[j..].
	const lcs = new Int32Array((rows + 1) * (cols + 1));
	for (let i = rows - 1; i >= 0; i--) {
		for (let j = cols - 1; j >= 0; j--) {
			lcs[i * (cols + 1) + j] =
				oldLines[i] === newLines[j]
					? lcs[(i + 1) * (cols + 1) + j + 1] + 1
					: Math.max(lcs[(i + 1) * (cols + 1) + j], lcs[i * (cols + 1) + j + 1]);
		}
	}
	const ops: MemoryDiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < rows && j < cols) {
		if (oldLines[i] === newLines[j]) {
			i++;
			j++;
			continue;
		}
		// Prefer removals on ties so a replaced block reads -old then +new.
		if (lcs[(i + 1) * (cols + 1) + j] >= lcs[i * (cols + 1) + j + 1]) ops.push({ kind: "-", text: oldLines[i++]! });
		else ops.push({ kind: "+", text: newLines[j++]! });
	}
	while (i < rows) ops.push({ kind: "-", text: oldLines[i++]! });
	while (j < cols) ops.push({ kind: "+", text: newLines[j++]! });
	return groupRemovalsFirst(ops);
}

/** Regroup the edit script so every change region reads -old lines then +new. */
function groupRemovalsFirst(ops: MemoryDiffLine[]): MemoryDiffLine[] {
	const grouped: MemoryDiffLine[] = [];
	let removals: MemoryDiffLine[] = [];
	for (const op of ops) {
		if (op.kind === "-") {
			removals.push(op);
			continue;
		}
		if (removals.length > 0) {
			grouped.push(...removals);
			removals = [];
		}
		grouped.push(op);
	}
	grouped.push(...removals);
	return grouped;
}
