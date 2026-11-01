import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { MemoryChannel } from "../src/core/memory/channel.ts";
import type { MemoryRecord } from "../src/core/memory/store.ts";
import { resolveProjectIdentity } from "../src/core/runtime/identity.ts";
import { RuntimeState } from "../src/core/runtime/state-db.ts";
import {
	buildChildCommand,
	loadAgentDefs,
	projectMemoryBlock,
	renderProjectMemory,
	SubagentCard,
	subagentRunsInBackground,
} from "../src/extensions/subagents/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

const baseDef = {
	name: "worker",
	description: "test",
	tools: ["read", "write", "edit", "bash", "subagent"],
	systemPrompt: "WORKER-PROMPT",
	filePath: undefined,
};

function build(overrides: Partial<Parameters<typeof buildChildCommand>[0]> = {}) {
	return buildChildCommand({
		def: baseDef,
		task: "do the thing",
		entryPath: "/repo/cli.ts",
		depth: 0,
		promptPath: "/tmp/prompt.md",
		taskPath: undefined,
		cwd: "/repo",
		...overrides,
	});
}

describe("buildChildCommand", () => {
	test("main agent's children get the tool, the extension file, and the depth pin", () => {
		const command = build();
		expect(command.toolGranted).toBe(true);
		const tools = command.args[command.args.indexOf("--tools") + 1];
		expect(tools?.split(",")).toContain("subagent");
		// Recursion re-enables this extension by builtin name — valid in source
		// and bundle launch modes — and children never load the persona pack.
		expect(command.args).toContain("builtin:subagents");
		expect(command.args).not.toContain("/repo/subagents/index.ts");
		expect(command.env.NEKO_PI_NO_PERSONA).toBe("1");
		expect(command.env).toEqual({ NEKO_PI_NO_PERSONA: "1", NEKO_PI_SUBAGENT_DEPTH: "1" });
		// Isolation flags are the boundary contract: no persona, no memory
		// tools, no session, no skills, no activity in the child.
		for (const flag of ["--no-extensions", "--no-session", "--no-skills", "--mode", "json", "--print"]) {
			expect(command.args).toContain(flag);
		}
	});

	test("the child process runs in the tool call's cwd", () => {
		const command = build({ cwd: "/work/resume-lib" });
		expect(command.cwd).toBe("/work/resume-lib");
	});

	test("grandchildren (layer 3) run toolless: no subagent tool, no extension load", () => {
		const command = build({ depth: 1 });
		expect(command.toolGranted).toBe(false);
		// The other tools stay; only the spawn tool is withheld.
		const tools = command.args[command.args.indexOf("--tools") + 1]?.split(",");
		expect(tools).not.toContain("subagent");
		expect(tools).toContain("read");
		expect(command.args).not.toContain("--extension");
		expect(command.env).toEqual({ NEKO_PI_NO_PERSONA: "1", NEKO_PI_SUBAGENT_DEPTH: "2" });
	});

	test("model fallback applies only when the definition pins none", () => {
		expect(build({ modelFallback: "zai/glm-5.3" }).args).toContain("zai/glm-5.3");
		const pinned = build({
			modelFallback: "zai/glm-5.3",
			def: { ...baseDef, model: "deepseek/deepseek-flash" },
		});
		expect(pinned.args).toContain("deepseek/deepseek-flash");
		expect(pinned.args).not.toContain("zai/glm-5.3");
	});

	test("project memory is folded into the child system prompt", () => {
		const command = build({ projectMemory: "<project_memory>\nFACT\n</project_memory>" });
		expect(command.prompt).toBe("WORKER-PROMPT\n\n<project_memory>\nFACT\n</project_memory>");
		expect(command.prompt.indexOf("WORKER-PROMPT")).toBeLessThan(command.prompt.indexOf("project_memory"));
	});

	test("long tasks require a task file and reference it", () => {
		const big = "x".repeat(9000);
		expect(() => build({ task: big })).toThrow("task file");
		const command = build({ task: big, taskPath: "/tmp/task.md" });
		expect(command.args.at(-1)).toBe("@/tmp/task.md");
	});

	test("without an entry path the well-known binary is used", () => {
		const command = build({ entryPath: undefined });
		expect(command.command).toBe("neko-pi");
		expect(command.args[0]).toBe("--mode");
	});
});

describe("renderProjectMemory", () => {
	const record = (title: string, body: string, updated: Date): MemoryRecord =>
		({
			id: `rec_${title}`,
			type: "anchor",
			title,
			body,
			salience: 0.5,
			created: updated,
			updated,
			tags: [],
			version: 1,
		}) as MemoryRecord;

	test("newest first, whole blocks, budget-capped without truncation", () => {
		const old = record("old", "A".repeat(3000), new Date(1000));
		const young = record("young", "B".repeat(3000), new Date(2000));
		const rendered = renderProjectMemory([old, young], 8 * 1024);
		expect(rendered.indexOf("young")).toBeLessThan(rendered.indexOf("old"));
		const tiny = renderProjectMemory([old, young], 4000);
		expect(tiny).toContain("young");
		expect(tiny).not.toContain("old");
		expect(tiny.endsWith("B".repeat(3000))).toBe(true);
	});
});

describe("loadAgentDefs", () => {
	test("built-ins exist and a user definition overrides by name", () => {
		const root = mkdtempSync(join(tmpdir(), "neko-subagents-"));
		dirs.push(root);
		vi.stubEnv("NEKO_PI_HOME", root);
		expect(loadAgentDefs(root).map((def) => def.name)).toEqual(expect.arrayContaining(["scout", "worker"]));
		mkdirSync(join(root, "agents"), { recursive: true });
		writeFileSync(
			join(root, "agents", "scout.md"),
			["---", "name: scout", "description: custom scout", "tools: read", "---", "", "CUSTOM-BODY"].join("\n"),
			"utf8",
		);
		const scout = loadAgentDefs(root).find((def) => def.name === "scout")!;
		expect(scout.systemPrompt).toBe("CUSTOM-BODY");
		expect(scout.tools).toEqual(["read"]);
		expect(scout.filePath).toContain(join(root, "agents"));
		expect(getAgentDir()).toBe(root);
	});
});

describe("projectMemoryBlock", () => {
	test("reads the current project's records, undefined when empty", () => {
		const root = mkdtempSync(join(tmpdir(), "neko-subagents-mem-"));
		dirs.push(root);
		vi.stubEnv("NEKO_PI_HOME", root);
		const cwd = join(root, "repo");
		mkdirSync(cwd, { recursive: true });
		const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
		const channel = new MemoryChannel(join(root, "memory"), state);
		const identity = resolveProjectIdentity(cwd);
		expect(projectMemoryBlock(cwd)).toBeUndefined();
		channel.write({
			type: "anchor",
			title: "repo fact",
			body: "PROJECT-FACT",
			source: "user",
			scope: { scope: "project", projectId: identity.projectId },
		});
		const block = projectMemoryBlock(cwd);
		expect(block).toContain("<project_memory>");
		expect(block).toContain("PROJECT-FACT");
		// Persona records are NOT the child's business.
		channel.write({
			type: "anchor",
			title: "persona fact",
			body: "PERSONA-FACT",
			source: "user",
			scope: { scope: "persona" },
		});
		expect(projectMemoryBlock(cwd)).not.toContain("PERSONA-FACT");
		state.close();
	});
});

describe("subagent run mode", () => {
	test("background is the default at the main layer; nested children always block", () => {
		expect(subagentRunsInBackground({}, 0)).toBe(true);
		expect(subagentRunsInBackground({ background: true }, 0)).toBe(true);
		expect(subagentRunsInBackground({ background: false }, 0)).toBe(false);
		// Headless children cannot be woken by notifications: their nested
		// calls block even when background was requested.
		expect(subagentRunsInBackground({}, 1)).toBe(false);
		expect(subagentRunsInBackground({ background: true }, 2)).toBe(false);
	});
});

describe("SubagentCard", () => {
	test("dispatched cards freeze with the job label, not a running clock", () => {
		initTheme("dark");
		const card = new SubagentCard("scout", "p", true, theme, () => {});
		card.markRunning(Date.now() - 60_000);
		card.finishDispatched("bg-9");
		const line = card.render(80).join("\n");
		expect(line).toContain("dispatched · bg-9");
		expect(line).toContain("✓");
		expect(line).not.toMatch(/\d+s · \d+ tools/);
	});

	test("framework invalidate does not re-enter redraw (stack overflow guard)", () => {
		initTheme("dark");
		let redraws = 0;
		const card = new SubagentCard("scout", "p", true, theme, () => {
			redraws += 1;
		});
		card.invalidate();
		card.invalidate();
		expect(redraws).toBe(0);
	});

	test("compact status line per phase; output only when expanded", () => {
		initTheme("dark");
		const card = new SubagentCard("scout", "survey the tree", true, theme, () => {});
		const running = card.render(80).join("\n");
		expect(running).toContain("subagent");
		expect(running).toContain("scout");
		expect(running).toContain("bg");
		card.markRunning(Date.now() - 1000);
		card.update({ toolCount: 3 });
		expect(card.render(80).join("\n")).toContain("3 tools");
		card.finish("final answer", false, 4);
		const done = card.render(80).join("\n");
		expect(done).toContain("✓");
		expect(done).not.toContain("final answer");
		card.setExpanded(true);
		expect(card.render(80).join("\n")).toContain("final answer");
		const failed = new SubagentCard("worker", "w", false, theme, () => {});
		failed.finish("boom", true, 1);
		expect(failed.render(80).join("\n")).toContain("✗");
	});
});
