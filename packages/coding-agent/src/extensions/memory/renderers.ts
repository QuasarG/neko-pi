/**
 * Presentation for the memory tools: memory_write, memory_promote, continuity_update.
 *
 * Renderers live apart from the extension wiring so a process that only displays tool
 * output loads no execution path. They read args and result details only — no behavior.
 * The model-facing result text stays compact; the row carries the scope badge, action
 * status, version transition, linked absolute path, and a bounded line diff computed
 * from the previous body in the details.
 */

import { Text } from "@earendil-works/pi-tui";
import type { ToolRenderers } from "../../core/extensions/types.ts";
import { linkPath, shortenPath, str } from "../../core/tools/render-utils.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

/** Details payload of memory_write / memory_promote results, produced by the extension. */
export interface MemoryWriteDetails {
	action: "created" | "merged" | "rejected" | "conflict";
	scope: "persona" | "toolbox" | "project" | "scratch";
	projectId?: string;
	/** Human-readable project name from the resolved identity; ids alone read as noise. */
	projectName?: string;
	absoluteFile?: string;
	recordId?: string;
	title?: string;
	type?: string;
	version?: number;
	previousVersion?: number;
	previousBody?: string;
	note?: string;
}

/** memory_promote adds the scratch origin on top of the target write details. */
export interface MemoryPromoteDetails extends MemoryWriteDetails {
	fromScope?: "scratch";
	fromFile?: string;
	fromVersion?: number;
}

/** Details payload of continuity_update results. */
export interface ContinuityToolDetails {
	saved: boolean;
	/** Written since the refactor; absent rows predate it and defaulted to persona. */
	scope?: "persona" | "project";
	reason?: "empty" | "budget";
	current?: { version: number; session?: string; updated?: number; summary?: string };
}

/** One changed line of a bounded diff: `-` removed, `+` added. */
export interface DiffLine {
	kind: "+" | "-";
	text: string;
}

/**
 * Line diff of two bodies: shared prefix and suffix lines are context and dropped,
 * the changed middle comes back as `-old` then `+new` lines, at most `limit` of them.
 */
export function lineDiff(oldBody: string, newBody: string, limit = 30): DiffLine[] {
	const oldLines = oldBody.split("\n");
	const newLines = newBody.split("\n");
	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
	let endOld = oldLines.length;
	let endNew = newLines.length;
	while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
		endOld--;
		endNew--;
	}
	const lines: DiffLine[] = [
		...oldLines.slice(start, endOld).map((text): DiffLine => ({ kind: "-", text })),
		...newLines.slice(start, endNew).map((text): DiffLine => ({ kind: "+", text })),
	];
	return lines.slice(0, Math.max(0, limit));
}

const DIFF_LINE_LIMIT = 30;
const CONTINUITY_SUMMARY_CHARS = 60;

/** Result rows recorded before the rich details existed: render their text unchanged. */
function legacyResultText(
	result: { content: Array<{ type: string; text?: string }> },
	theme: Theme,
	isError: boolean,
): string {
	const output = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	if (!output) return "";
	return theme.fg(isError ? "error" : "toolOutput", output);
}

function readWriteDetails(raw: unknown): MemoryWriteDetails | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const candidate = raw as Partial<MemoryWriteDetails>;
	if (typeof candidate.action !== "string" || typeof candidate.scope !== "string") return undefined;
	return candidate as MemoryWriteDetails;
}

function readPromoteDetails(raw: unknown): MemoryPromoteDetails | undefined {
	const base = readWriteDetails(raw);
	if (!base) return undefined;
	const candidate = raw as Partial<MemoryPromoteDetails>;
	return {
		...base,
		...(candidate.fromScope === "scratch" ? { fromScope: candidate.fromScope } : {}),
		...(typeof candidate.fromFile === "string" ? { fromFile: candidate.fromFile } : {}),
		...(typeof candidate.fromVersion === "number" ? { fromVersion: candidate.fromVersion } : {}),
	};
}

function readContinuityDetails(raw: unknown): ContinuityToolDetails | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const candidate = raw as Partial<ContinuityToolDetails>;
	if (typeof candidate.saved !== "boolean") return undefined;
	return candidate as ContinuityToolDetails;
}

/**
 * `project` badges prefer the human project name and fall back to the short id,
 * like the injected-memory sections do.
 */
function scopeLabel(details: Pick<MemoryWriteDetails, "scope" | "projectId" | "projectName">): string {
	if (details.scope !== "project") return details.scope;
	if (typeof details.projectName === "string" && details.projectName) return `project ${details.projectName}`;
	return details.projectId ? `project ${details.projectId.slice(0, 8)}` : "project";
}

function linkedPath(file: string, theme: Theme, cwd: string, color: "accent" | "muted"): string {
	return linkPath(theme.fg(color, shortenPath(file)), file, cwd);
}

/** `v4 → v5` for merges, `v5` alone for fresh records, nothing without a version. */
function versionText(details: MemoryWriteDetails): string {
	if (typeof details.version !== "number") return "";
	if (typeof details.previousVersion === "number") return `v${details.previousVersion} → v${details.version}`;
	return `v${details.version}`;
}

function formatMemoryResult(
	details: MemoryWriteDetails,
	options: {
		promote?: MemoryPromoteDetails;
		newBody: string | undefined;
		expanded: boolean;
		cwd: string;
	},
	theme: Theme,
): string {
	const failed = details.action === "conflict" || details.action === "rejected";
	// A failed promotion may still carry the target scope it never reached; the
	// badge names where the record actually is, which is the scratch scope.
	const targetLabel = scopeLabel(details);
	const badge =
		failed && options.promote?.fromScope === "scratch"
			? options.promote.fromScope
			: options.promote
				? `${options.promote.fromScope ?? "scratch"} → ${targetLabel}`
				: targetLabel;
	const head = [
		theme.fg("accent", badge),
		theme.fg(failed ? "error" : "success", details.action),
		versionText(details) ? theme.fg("muted", versionText(details)) : "",
	]
		.filter(Boolean)
		.join(" ");
	const lines: string[] = [head];
	const title = typeof details.title === "string" ? details.title : "";
	const type = typeof details.type === "string" ? details.type : "";
	if (title || type) lines.push([title, type ? theme.fg("dim", type) : ""].filter(Boolean).join(" · "));
	if (typeof details.absoluteFile === "string")
		lines.push(linkedPath(details.absoluteFile, theme, options.cwd, "accent"));
	if (!failed && typeof options.promote?.fromFile === "string")
		lines.push(`from ${linkedPath(options.promote.fromFile, theme, options.cwd, "muted")}`);
	// The diff needs both bodies: the previous one from details, the new one from the
	// call args. A rejected body may hold secret material, so it is never echoed.
	if (
		options.expanded &&
		details.action !== "rejected" &&
		typeof details.previousBody === "string" &&
		typeof options.newBody === "string"
	) {
		for (const line of lineDiff(details.previousBody, options.newBody, DIFF_LINE_LIMIT))
			lines.push(theme.fg(line.kind === "-" ? "toolDiffRemoved" : "toolDiffAdded", `${line.kind}${line.text}`));
	}
	if (typeof details.note === "string" && details.note) lines.push(theme.fg(failed ? "error" : "muted", details.note));
	return lines.join("\n");
}

function resultTextComponent(context: { lastComponent: unknown }, text: string): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(text);
	return component;
}

/** The model streams args progressively; a missing piece just drops out of the header. */
function callHeader(title: string, parts: string[], theme: Theme): string {
	const visible = parts.filter(Boolean);
	const header = theme.fg("toolTitle", theme.bold(title));
	return visible.length > 0 ? `${header} ${visible.join(theme.fg("muted", " · "))}` : header;
}

type MemoryWriteArgs = { scope?: unknown; type?: unknown; title?: unknown; body?: unknown };

export const memoryWriteRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const renderArgs = (args ?? {}) as MemoryWriteArgs;
		const scope = str(renderArgs.scope);
		const type = str(renderArgs.type);
		const title = str(renderArgs.title);
		const text = callHeader(
			"memory_write",
			[scope ? theme.fg("accent", scope) : "", type ? theme.fg("dim", type) : "", title || ""],
			theme,
		);
		return resultTextComponent(context, text);
	},
	renderResult(result, options, theme, context) {
		const details = readWriteDetails(result.details);
		if (!details) {
			return resultTextComponent(context, legacyResultText(result, theme, context.isError));
		}
		const newBody = str((context.args as MemoryWriteArgs | undefined)?.body) || undefined;
		return resultTextComponent(
			context,
			formatMemoryResult(details, { newBody, expanded: options.expanded, cwd: context.cwd }, theme),
		);
	},
};

type MemoryPromoteArgs = { record_id?: unknown; scope?: unknown };

export const memoryPromoteRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const renderArgs = (args ?? {}) as MemoryPromoteArgs;
		const scope = str(renderArgs.scope);
		const recordId = str(renderArgs.record_id);
		const text = callHeader(
			"memory_promote",
			[scope ? theme.fg("accent", `scratch → ${scope}`) : "", recordId ? theme.fg("dim", recordId) : ""],
			theme,
		);
		return resultTextComponent(context, text);
	},
	renderResult(result, options, theme, context) {
		const details = readPromoteDetails(result.details);
		if (!details) {
			return resultTextComponent(context, legacyResultText(result, theme, context.isError));
		}
		// The promoted body is the scratch record's, not an argument, so no diff is shown.
		return resultTextComponent(
			context,
			formatMemoryResult(
				details,
				{ promote: details, newBody: undefined, expanded: options.expanded, cwd: context.cwd },
				theme,
			),
		);
	},
};

type ContinuityArgs = { summary?: unknown; scope?: unknown };

/**
 * Which continuity scope a row belongs to. Details carry it on every write since
 * the refactor; explicit args name it for in-flight calls. A row with neither is
 * a legacy result, and omitted scope meant persona before the refactor.
 */
function continuityScope(details: ContinuityToolDetails | undefined, args: ContinuityArgs | undefined) {
	if (details?.scope === "persona" || details?.scope === "project") return details.scope;
	if (args?.scope === "persona" || args?.scope === "project") return args.scope;
	return "persona";
}

function oneLine(value: string): string {
	return value.split("\n")[0] ?? "";
}

export const continuityRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const renderArgs = (args ?? {}) as ContinuityArgs;
		const summary = str(renderArgs.summary);
		// An omitted call arg means project now but meant persona before the
		// refactor; without a result there is no way to tell, so the call header
		// names a scope only when the model chose one explicitly.
		const explicitScope =
			renderArgs.scope === "persona" || renderArgs.scope === "project" ? renderArgs.scope : undefined;
		let summaryPart = "";
		if (summary) {
			const line = context.expanded ? summary.trim() : oneLine(summary).trim();
			summaryPart = context.expanded
				? line
				: line.length > CONTINUITY_SUMMARY_CHARS
					? `${line.slice(0, CONTINUITY_SUMMARY_CHARS - 1)}…`
					: line;
		}
		const text = callHeader(
			"continuity_update",
			[explicitScope ? theme.fg("accent", explicitScope) : "", summaryPart],
			theme,
		);
		return resultTextComponent(context, text);
	},
	renderResult(result, _options, theme, context) {
		const details = readContinuityDetails(result.details);
		if (!details) {
			return resultTextComponent(context, legacyResultText(result, theme, context.isError));
		}
		const scope = continuityScope(details, (context.args as ContinuityArgs | undefined) ?? undefined);
		const state = details.saved ? theme.fg("success", "saved") : theme.fg("error", "not saved");
		// The failure suffix says why: a refused reason, or the version to merge against.
		let suffix = "";
		if (!details.saved) {
			if (details.reason) suffix = theme.fg("muted", ` · ${details.reason}`);
			else if (details.current)
				suffix = theme.fg("muted", ` · current v${details.current.version}, merge and retry`);
		}
		const text = `${theme.fg("accent", scope)} ${state}${suffix}`;
		return resultTextComponent(context, text);
	},
};
