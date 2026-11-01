import { homedir } from "node:os";
import { join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";

import type { ToolRenderContext, ToolRenderers } from "../src/core/extensions/types.ts";
import type {
	ContinuityToolDetails,
	MemoryPromoteDetails,
	MemoryWriteDetails,
} from "../src/extensions/memory/renderers.ts";
import {
	continuityRenderers,
	lineDiff,
	memoryPromoteRenderers,
	memoryWriteRenderers,
} from "../src/extensions/memory/renderers.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const PROJECT_FILE = join(homedir(), ".neko_pi/memory/projects/x/records/a.md");
const SCRATCH_FILE = join(homedir(), ".neko_pi/memory/scratch/rec_y.md");
const PERSONA_FILE = join(homedir(), ".neko_pi/memory/persona/anchor-x.md");

function renderContext(args: Record<string, unknown>, overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
	return {
		args,
		toolCallId: "call-1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError: false,
		durationMs: 4,
		outputPad: 1,
		...overrides,
	};
}

/** Raw render of a renderer slot; strip ANSI separately so color assertions can use the raw text. */
function renderSlot(
	renderers: ToolRenderers,
	slot: "renderCall" | "renderResult",
	args: Record<string, unknown>,
	options: {
		content?: Array<{ type: "text"; text: string }>;
		details?: unknown;
		isError?: boolean;
		expanded?: boolean;
	} = {},
): string {
	const context = renderContext(args, {
		expanded: options.expanded ?? true,
		isError: options.isError ?? false,
	});
	const component: Component =
		slot === "renderCall"
			? renderers.renderCall!(args, theme, context)
			: renderers.renderResult!(
					{ content: options.content ?? [], details: options.details },
					{ expanded: context.expanded, isPartial: false },
					theme,
					context,
				);
	return component.render(120).join("\n");
}

// Top level so focused runs of any describe still get an initialized theme.
beforeAll(() => {
	initTheme("dark");
});

describe("lineDiff", () => {
	test("trims the common prefix and suffix and reports the middle as -old/+new", () => {
		expect(lineDiff("keep\nold one\nold two\ntail", "keep\nnew one\ntail")).toEqual([
			{ kind: "-", text: "old one" },
			{ kind: "-", text: "old two" },
			{ kind: "+", text: "new one" },
		]);
	});

	test("returns nothing for identical bodies", () => {
		expect(lineDiff("same\nbody", "same\nbody")).toEqual([]);
	});

	test("bounds the diff to the limit", () => {
		const oldBody = Array.from({ length: 40 }, (_, i) => `old ${i}`).join("\n");
		const newBody = Array.from({ length: 40 }, (_, i) => `new ${i}`).join("\n");
		expect(lineDiff(oldBody, newBody)).toHaveLength(30);
		expect(lineDiff(oldBody, newBody, 5)).toHaveLength(5);
	});
});

describe("memory_write renderers", () => {
	test("shows scope, title/type, version transition, path, and the bounded diff", () => {
		const rendered = renderSlot(
			memoryWriteRenderers,
			"renderResult",
			{
				type: "procedure",
				title: "deploy",
				body: "new line\nshared",
				scope: "project",
			},
			{
				details: {
					action: "merged",
					scope: "project",
					projectId: "bed947e0",
					absoluteFile: PROJECT_FILE,
					title: "deploy",
					type: "procedure",
					version: 5,
					previousVersion: 4,
					previousBody: "old line\nshared",
				} satisfies MemoryWriteDetails,
			},
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("project");
		expect(text).toContain("deploy");
		expect(text).toContain("procedure");
		expect(text).toContain("v4 → v5");
		expect(text).toContain("~/.neko_pi/memory/projects/x/records/a.md");
		expect(text).toContain("-old line");
		expect(text).toContain("+new line");
		// The shared suffix is context, not a change.
		expect(text).not.toContain("-shared");
		expect(rendered).toContain(theme.fg("success", "merged"));
	});

	test("project badges prefer the human project name over the id", () => {
		const rendered = renderSlot(
			memoryWriteRenderers,
			"renderResult",
			{
				type: "procedure",
				title: "deploy",
				body: "new",
				scope: "project",
			},
			{
				details: {
					action: "merged",
					scope: "project",
					projectId: "bed947e0deadbeef",
					projectName: "neko-pi",
					absoluteFile: PROJECT_FILE,
					title: "deploy",
					type: "procedure",
					version: 5,
					previousVersion: 4,
					previousBody: "old",
				} satisfies MemoryWriteDetails,
			},
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("project neko-pi");
		expect(text).not.toContain("bed947e0");
	});

	test("created records show the new version without a transition", () => {
		const rendered = renderSlot(
			memoryWriteRenderers,
			"renderResult",
			{
				type: "anchor",
				title: "锚点",
				body: "durable fact",
				scope: "persona",
			},
			{
				details: {
					action: "created",
					scope: "persona",
					absoluteFile: PERSONA_FILE,
					title: "锚点",
					type: "anchor",
					version: 1,
				} satisfies MemoryWriteDetails,
			},
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("persona");
		expect(text).toContain("created");
		expect(text).toContain("v1");
		expect(text).not.toContain("→");
		expect(rendered).toContain(theme.fg("success", "created"));
	});

	test("conflicts render as errors even though the content text remains model-friendly", () => {
		const note = "stale version: merge v6 and retry";
		const rendered = renderSlot(
			memoryWriteRenderers,
			"renderResult",
			{
				type: "procedure",
				title: "deploy",
				body: "attempt",
				scope: "project",
			},
			{
				details: {
					action: "conflict",
					scope: "project",
					projectId: "bed947e0",
					title: "deploy",
					type: "procedure",
					version: 7,
					previousVersion: 6,
					note,
				} satisfies MemoryWriteDetails,
				isError: true,
			},
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("conflict");
		expect(text).toContain(note);
		expect(rendered).toContain(theme.fg("error", "conflict"));
		expect(rendered).not.toContain(theme.fg("success", "conflict"));
	});

	test("rejected writes show the refusal reason as an error", () => {
		const note = "body looks like a secret; store a reference instead";
		const rendered = renderSlot(
			memoryWriteRenderers,
			"renderResult",
			{
				type: "anchor",
				title: "keys",
				body: "password: hunter2",
				scope: "persona",
			},
			{
				details: {
					action: "rejected",
					scope: "persona",
					title: "keys",
					type: "anchor",
					note,
				} satisfies MemoryWriteDetails,
				isError: true,
			},
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("rejected");
		expect(text).toContain(note);
		expect(rendered).toContain(theme.fg("error", "rejected"));
	});

	test("collapsed results keep the summary lines but hide the diff", () => {
		const rendered = renderSlot(
			memoryWriteRenderers,
			"renderResult",
			{
				type: "procedure",
				title: "deploy",
				body: "new line\nshared",
				scope: "project",
			},
			{
				details: {
					action: "merged",
					scope: "project",
					projectId: "bed947e0",
					absoluteFile: PROJECT_FILE,
					title: "deploy",
					type: "procedure",
					version: 5,
					previousVersion: 4,
					previousBody: "old line\nshared",
				} satisfies MemoryWriteDetails,
				expanded: false,
			},
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("merged");
		expect(text).toContain("v4 → v5");
		expect(text).toContain("~/.neko_pi/memory/projects/x/records/a.md");
		expect(text).not.toContain("-old line");
		expect(text).not.toContain("+new line");
	});

	test("results without details fall back to the recorded content text", () => {
		const rendered = renderSlot(
			memoryWriteRenderers,
			"renderResult",
			{},
			{
				content: [{ type: "text", text: "personamerged (file.md) v1" }],
			},
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("personamerged (file.md) v1");
		expect(stripAnsi(renderSlot(memoryWriteRenderers, "renderResult", {}, {}))).toBe("");
	});

	test("renders the call header with scope, type, and title from the args", () => {
		const rendered = renderSlot(memoryWriteRenderers, "renderCall", {
			type: "promise",
			title: "欠欠本",
			body: "durable fact",
			scope: "persona",
		});
		const text = stripAnsi(rendered);
		expect(text).toContain("memory_write");
		expect(text).toContain("persona");
		expect(text).toContain("promise");
		expect(text).toContain("欠欠本");
	});
});

describe("memory_promote renderers", () => {
	test("successful promotions show the scratch → target badge and both files", () => {
		const details: MemoryPromoteDetails = {
			action: "merged",
			scope: "project",
			projectId: "bed947e0",
			absoluteFile: PROJECT_FILE,
			title: "server facts",
			type: "anchor",
			version: 2,
			previousVersion: 1,
			previousBody: "old",
			fromScope: "scratch",
			fromFile: SCRATCH_FILE,
			fromVersion: 3,
		};
		const rendered = renderSlot(
			memoryPromoteRenderers,
			"renderResult",
			{
				record_id: "rec_y",
				scope: "project",
			},
			{ details },
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("scratch → project");
		expect(text).toContain("server facts");
		expect(text).toContain("v1 → v2");
		expect(text).toContain("~/.neko_pi/memory/projects/x/records/a.md");
		expect(text).toContain("~/.neko_pi/memory/scratch/rec_y.md");
		expect(rendered).toContain(theme.fg("success", "merged"));
	});

	test("failed promotions badge the scratch scope, not the unreachable target", () => {
		const details: MemoryPromoteDetails = {
			action: "conflict",
			scope: "project",
			projectId: "bed947e0",
			title: "server facts",
			type: "anchor",
			version: 7,
			note: "target record changed; merge and retry",
			fromScope: "scratch",
			fromVersion: 3,
		};
		const rendered = renderSlot(
			memoryPromoteRenderers,
			"renderResult",
			{
				record_id: "rec_y",
				scope: "project",
			},
			{ details, isError: true },
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("scratch");
		expect(text).not.toContain("scratch → project");
		expect(text).toContain("conflict");
		expect(text).toContain("target record changed; merge and retry");
		expect(rendered).toContain(theme.fg("error", "conflict"));
	});

	test("renders the call header with the promotion target and record id", () => {
		const rendered = renderSlot(memoryPromoteRenderers, "renderCall", {
			record_id: "rec_y",
			scope: "project",
		});
		const text = stripAnsi(rendered);
		expect(text).toContain("memory_promote");
		expect(text).toContain("scratch → project");
		expect(text).toContain("rec_y");
	});
});

describe("continuity renderers", () => {
	test("new rows read the project scope from details even when the args omit it", () => {
		const summary = "Renderer tests green; wire renderers into registerTool next.";
		const rendered = renderSlot(
			continuityRenderers,
			"renderResult",
			{ summary },
			{
				details: { saved: true, scope: "project" } satisfies ContinuityToolDetails,
			},
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("project");
		expect(text).toContain("saved");
		expect(rendered).toContain(theme.fg("success", "saved"));

		const call = stripAnsi(renderSlot(continuityRenderers, "renderCall", { summary, scope: "project" }, {}));
		expect(call).toContain("continuity_update");
		expect(call).toContain("project");
		expect(call).toContain("Renderer tests green;");
	});

	test("new rows read a persona scope from details", () => {
		const rendered = renderSlot(
			continuityRenderers,
			"renderResult",
			{ summary: "stage note" },
			{
				details: { saved: true, scope: "persona" } satisfies ContinuityToolDetails,
			},
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("persona");
		expect(text).not.toContain("project");
	});

	test("explicit persona args label the row when details lack a scope", () => {
		const rendered = renderSlot(
			continuityRenderers,
			"renderResult",
			{
				summary: "stage note",
				scope: "persona",
			},
			{
				details: { saved: true } satisfies ContinuityToolDetails,
			},
		);
		expect(stripAnsi(rendered)).toContain("persona");
	});

	test("legacy rows with no scope anywhere infer the pre-refactor persona default", () => {
		const rendered = renderSlot(
			continuityRenderers,
			"renderResult",
			{ summary: "old stage note" },
			{
				details: { saved: true } satisfies ContinuityToolDetails,
			},
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("persona");
		expect(text).not.toContain("project");
	});

	test("call headers omit the scope when the args leave it ambiguous", () => {
		const call = stripAnsi(renderSlot(continuityRenderers, "renderCall", { summary: "stage note" }, {}));
		expect(call).toContain("continuity_update");
		expect(call).toContain("stage note");
		expect(call).not.toContain("persona");
		expect(call).not.toContain("project");
	});

	test("failed rows render not saved with the reason, even without isError", () => {
		const rendered = renderSlot(
			continuityRenderers,
			"renderResult",
			{
				summary: "over budget",
			},
			{
				details: { saved: false, reason: "budget", scope: "project" } satisfies ContinuityToolDetails,
				isError: false,
			},
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("not saved");
		expect(text).toContain("budget");
		expect(text).toContain("project");
		expect(rendered).toContain(theme.fg("error", "not saved"));
	});

	test("conflicts name the current version to merge", () => {
		const rendered = renderSlot(
			continuityRenderers,
			"renderResult",
			{
				summary: "stage note",
			},
			{
				details: {
					saved: false,
					scope: "project",
					current: { version: 6, summary: "other session" },
				} satisfies ContinuityToolDetails,
			},
		);
		const text = stripAnsi(rendered);
		expect(text).toContain("not saved");
		expect(text).toContain("v6");
		expect(rendered).toContain(theme.fg("error", "not saved"));
	});
});
