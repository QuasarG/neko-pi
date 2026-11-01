/**
 * Subagents extension: a single `subagent` tool that spawns an isolated
 * headless neko-pi process per task.
 *
 * Boundaries (by design, enforced with child CLI flags):
 * - Children run with `--no-extensions`: no persona pack, no wardrobe, no
 *   memory tools, no activity recording — none of the persona-scope machinery
 *   exists in the child process at all.
 * - The child gets the default base system prompt plus a read-only snapshot of
 *   the CURRENT PROJECT's memory records, folded into its system prompt by the
 *   parent. It cannot write memory anywhere.
 * - Only the main agent talks to subagents: children are `--print` one-shots
 *   with no session, no user channel, and no resume entry.
 * - Recursion is depth-capped: the main agent is layer 0, its children layer 1
 *   may spawn, and layer 2 children receive no `subagent` tool (three layers
 *   total, the last one toolless).
 *
 * Subagents run in the background by default: the call returns immediately
 * and the finished output wakes the main agent as a task notification.
 * `background: false` blocks until the child exits and returns the output in
 * the tool result (foreground jobs still count in the status bar and /tasks;
 * they just never notify).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Component, Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir, getCliEntryPath } from "../../config.ts";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { getMemoryChannel } from "../../core/memory/channel.ts";
import type { MemoryRecord } from "../../core/memory/store.ts";
import { resolveProjectIdentity } from "../../core/runtime/identity.ts";
import { finishBackgroundJob, registerBackgroundJob } from "../../core/tools/background-jobs.ts";
import { truncateHead } from "../../core/tools/truncate.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { ensureSystemToolsActive } from "../system-tool-repair.ts";

// ── Constants ──────────────────────────────────────────────────────────

/** Depth env var: pinned on every child so descendants know its layer. */
const DEPTH_ENV = "NEKO_PI_SUBAGENT_DEPTH";
/**
 * Children run the harness default identity, never the installed persona
 * pack: the persona loader returns null under this flag. Children are
 * work processes; the persona belongs to the main agent only.
 */
const NO_PERSONA_ENV = { NEKO_PI_NO_PERSONA: "1" };
/**
 * How the child re-enables this very extension for recursion. A
 * `builtin:<name>` reference resolves in every launch mode (source checkout
 * and installed bundle alike); a file path would break in the bundle, where
 * this module's code lives inside an opaque chunk.
 */
const EXTENSION_REF = "builtin:subagents";
/**
 * Layers: main agent (0) → child (1) → grandchild (2). A child may itself
 * receive the `subagent` tool only while its depth stays ≤ 1, so layer 2
 * runs toolless — three layers total, per the depth rule.
 */
const MAX_TOOL_DEPTH = 1;
/** Per-child system-prompt budget for the project-memory snapshot, UTF-8 bytes. */
const PROJECT_MEMORY_BUDGET = 8 * 1024;
/** Task bodies longer than this go to a temp file instead of argv. */
const TASK_ARG_LIMIT = 8000;
const DEFAULT_MAX_CONCURRENCY = 4;

// ── Agent definitions ──────────────────────────────────────────────────

export interface SubagentDef {
	name: string;
	description: string;
	tools: string[];
	/** `provider/id`; undefined inherits the parent session's current model. */
	model?: string;
	thinking?: string;
	systemPrompt: string;
	filePath: string | undefined;
}

const BUILTIN_DEFS: SubagentDef[] = [
	{
		name: "scout",
		description: "Fast read-only codebase reconnaissance: find files, trace definitions, summarize structure.",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt:
			"You are a read-only codebase scout. Investigate quickly and report findings as compact prose: file paths, key symbols, and a direct answer to the task. Do not modify anything.",
		filePath: undefined,
	},
	{
		name: "worker",
		description: "Makes focused code changes with the standard file tools; may scout first.",
		tools: ["read", "write", "edit", "bash", "subagent"],
		systemPrompt:
			"You are a focused implementation worker. Make the smallest correct change for the task, verify it compiles or passes the relevant check, and report what changed and how you verified it.",
		filePath: undefined,
	},
];

function parseDefFile(content: string, filePath: string): SubagentDef | undefined {
	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
	if (!frontmatter?.name || !body.trim()) return undefined;
	return {
		name: frontmatter.name.trim(),
		description: (frontmatter.description ?? "").trim(),
		tools: (frontmatter.tools ?? "")
			.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean),
		model: frontmatter.model?.trim() || undefined,
		thinking: frontmatter.thinking?.trim() || undefined,
		systemPrompt: body.trim(),
		filePath,
	};
}

/** Agent defs: built-ins first, then user overrides by name from the global and project directories. */
export function loadAgentDefs(cwd: string): SubagentDef[] {
	const dirs = [join(getAgentDir(), "agents"), join(cwd, CONFIG_DIR_NAME, "agents")];
	const byName = new Map<string, SubagentDef>();
	for (const def of BUILTIN_DEFS) byName.set(def.name, def);
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir)) {
			if (!entry.endsWith(".md")) continue;
			const filePath = join(dir, entry);
			try {
				const def = parseDefFile(readFileSync(filePath, "utf8"), filePath);
				if (def) byName.set(def.name, def);
			} catch {
				// An unparsable user definition is skipped, not fatal.
			}
		}
	}
	return [...byName.values()];
}

// ── Project memory snapshot (read-only, folded into the child prompt) ──

/** Render active project records newest-first under the byte budget. */
export function renderProjectMemory(records: MemoryRecord[], budgetBytes = PROJECT_MEMORY_BUDGET): string {
	const sorted = [...records].sort((a, b) => b.updated.getTime() - a.updated.getTime());
	const blocks: string[] = [];
	let used = 0;
	for (const record of sorted) {
		const block = `## ${record.title}\n${record.body}`;
		const size = Buffer.byteLength(block, "utf8");
		if (used + size > budgetBytes) break;
		blocks.push(block);
		used += size;
	}
	return blocks.join("\n\n");
}

export function projectMemoryBlock(cwd: string): string | undefined {
	try {
		const identity = resolveProjectIdentity(cwd);
		const records = getMemoryChannel().store({ scope: "project", projectId: identity.projectId }).list(true);
		const rendered = renderProjectMemory(records);
		return rendered ? `<project_memory>\n${rendered}\n</project_memory>` : undefined;
	} catch {
		return undefined;
	}
}

// ── Child command construction (pure; unit-tested) ─────────────────────

export interface ChildCommand {
	command: string;
	args: string[];
	env: Record<string, string>;
	prompt: string;
	toolGranted: boolean;
	/** Working directory for the child process; defaults to the parent's. */
	cwd: string;
}

export interface BuildChildInput {
	def: SubagentDef;
	task: string;
	/** Real path of the running CLI entry (process.argv[1]); children reuse it. */
	entryPath: string | undefined;
	/** Depth of the process BUILDING this command (main = 0). */
	depth: number;
	/** Temp file holding the child system prompt (agent prompt + project memory). */
	promptPath: string;
	/** Temp file holding the task body, required for tasks over TASK_ARG_LIMIT. */
	taskPath: string | undefined;
	projectMemory?: string;
	/** `provider/id` used when the definition does not pin a model. */
	modelFallback?: string;
	/** Working directory for the child process (the tool call's cwd). */
	cwd?: string;
}

export function buildChildCommand(input: BuildChildInput): ChildCommand {
	const childDepth = input.depth + 1;
	const toolGranted = input.def.tools.includes("subagent") && childDepth <= MAX_TOOL_DEPTH;
	const allowlist = input.def.tools.filter((tool) => tool !== "subagent" || toolGranted);
	const prompt = [input.def.systemPrompt, input.projectMemory].filter(Boolean).join("\n\n");

	const args = ["--mode", "json", "--print", "--no-session", "--no-skills", "--no-extensions"];
	if (allowlist.length > 0) args.push("--tools", allowlist.join(","));
	else args.push("--no-tools");
	if (toolGranted) args.push("--extension", EXTENSION_REF);
	const model = input.def.model ?? input.modelFallback;
	if (model) args.push("--models", model);
	if (input.def.thinking) args.push("--thinking", input.def.thinking);
	args.push("--append-system-prompt", input.promptPath);
	if (input.task.length > TASK_ARG_LIMIT) {
		if (!input.taskPath) throw new Error("Long tasks require a task file path");
		args.push(`@${input.taskPath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	return {
		// execArgv is fork-only; dev-mode import flags ride along as leading args.
		command: input.entryPath ? process.execPath : "neko-pi",
		cwd: input.cwd ?? process.cwd(),
		args: input.entryPath ? [...process.execArgv, input.entryPath, ...args] : args,
		env: { ...NO_PERSONA_ENV, [DEPTH_ENV]: String(childDepth) },
		prompt,
		toolGranted,
	};
}

// ── Child execution ────────────────────────────────────────────────────

export interface ChildRun {
	output: string;
	exitCode: number;
	toolCount: number;
	error?: string;
	usage: { input: number; output: number };
}

function runChildProcess(
	command: ChildCommand,
	signal: AbortSignal | undefined,
	onTool?: () => void,
): Promise<ChildRun> {
	return new Promise((resolve) => {
		const run: ChildRun = { output: "", exitCode: 0, toolCount: 0, usage: { input: 0, output: 0 } };
		const proc = spawn(command.command, command.args, {
			stdio: ["ignore", "pipe", "pipe"] as const,
			cwd: command.cwd,
			env: { ...process.env, ...command.env },
		});
		let stdout = "";
		let stderr = "";

		const handleLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line) as Record<string, unknown>;
				if (event.type === "tool_execution_start") {
					run.toolCount += 1;
					onTool?.();
				}
				if (
					event.type === "message_end" &&
					(event.message as { role?: string } | undefined)?.role === "assistant"
				) {
					const message = event.message as {
						content?: unknown;
						usage?: { input?: number; output?: number };
						errorMessage?: string;
					};
					if (Array.isArray(message.content)) {
						const text = message.content
							.filter(
								(block): block is { type: "text"; text: string } =>
									(block as { type?: string }).type === "text",
							)
							.map((block) => block.text)
							.join("\n");
						if (text) run.output = text;
					}
					run.usage.input += message.usage?.input ?? 0;
					run.usage.output += message.usage?.output ?? 0;
					if (message.errorMessage) run.error = message.errorMessage;
				}
			} catch {
				// Non-JSON lines are expected noise.
			}
		};

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			const lines = stdout.split("\n");
			stdout = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		proc.on("close", (code) => {
			if (stdout.trim()) handleLine(stdout);
			run.exitCode = code ?? 1;
			if (run.exitCode !== 0 && stderr.trim() && !run.error) run.error = stderr.trim().split("\n").at(-1);
			resolve(run);
		});
		proc.on("error", (error) => {
			run.exitCode = 1;
			run.error = error.message;
			resolve(run);
		});
		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
				}, 3000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

// ── Extension ──────────────────────────────────────────────────────────

interface SubagentsConfig {
	maxConcurrency?: number;
}

function loadConfig(): SubagentsConfig {
	try {
		const path = join(getAgentDir(), "subagents.json");
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as SubagentsConfig;
	} catch {}
	return {};
}

/** Per-process semaphore over concurrent child processes. */
class Semaphore {
	private inFlight = 0;
	private readonly waiters: Array<() => void> = [];
	private readonly max: number;

	constructor(max: number) {
		this.max = max;
	}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		while (this.inFlight >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.inFlight += 1;
		try {
			return await fn();
		} finally {
			this.inFlight -= 1;
			this.waiters.shift()?.();
		}
	}
}

/**
 * One compact, live status card per subagent call (Kimi-style): a spinner
 * while running, phase colors on completion, elapsed time and tool count —
 * and the child's output only when the row is expanded. The card owns a
 * frame timer and invalidates itself, so the spinner animates without any
 * transcript reflow; the process body never scrolls the conversation.
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const CARD_FRAME_MS = 130;
/** A leaked heartbeat timer would outlive an aborted run; cap its life. */
const CARD_TIMER_CAP_MS = 30 * 60 * 1000;

export class SubagentCard implements Component {
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private bornAt = Date.now();
	private phase: "starting" | "running" | "done" | "failed" = "starting";
	private startedAt: number | undefined;
	private finishedAt: number | undefined;
	private toolCount = 0;
	private output = "";
	private expanded = false;
	private dispatchedLabel: string | undefined;

	private readonly agent: string;
	private readonly preview: string;
	private readonly background: boolean;
	private readonly theme: Theme;
	private readonly redraw: () => void;

	constructor(agent: string, preview: string, background: boolean, theme: Theme, redraw: () => void) {
		this.agent = agent;
		this.preview = preview;
		this.background = background;
		this.theme = theme;
		this.redraw = redraw;
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
			if (Date.now() - this.bornAt > CARD_TIMER_CAP_MS) this.stopTimer();
			this.redraw();
		}, CARD_FRAME_MS);
	}

	private stopTimer(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	markRunning(startedAt: number): void {
		this.phase = "running";
		this.startedAt = startedAt;
	}

	update(details: { phase?: string; startedAt?: number; toolCount?: number }): void {
		if (details.startedAt) this.startedAt = details.startedAt;
		if (typeof details.toolCount === "number") this.toolCount = details.toolCount;
		if (details.phase === "running" && this.phase === "starting") this.phase = "running";
	}

	finishDispatched(jobId: string): void {
		this.stopTimer();
		this.phase = "done";
		this.dispatchedLabel = `dispatched · ${jobId}`;
		this.finishedAt = Date.now();
	}

	finish(output: string, failed: boolean, toolCount: number): void {
		this.stopTimer();
		this.phase = failed ? "failed" : "done";
		this.output = output;
		this.toolCount = toolCount;
		this.finishedAt = Date.now();
	}

	get agentName(): string {
		return this.agent;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	private elapsedSeconds(): number {
		const end = this.finishedAt ?? Date.now();
		return Math.max(0, Math.round((end - (this.startedAt ?? this.bornAt)) / 100) / 10);
	}

	render(width: number): string[] {
		const icon =
			this.phase === "running"
				? this.theme.fg("warning", SPINNER_FRAMES[this.frame]!)
				: this.phase === "starting"
					? this.theme.fg("dim", "○")
					: this.phase === "done"
						? this.theme.fg("success", "✓")
						: this.theme.fg("error", "✗");
		const mode = this.background ? this.theme.fg("dim", " bg") : "";
		const head = `${icon} ${this.theme.fg("toolTitle", this.theme.bold("subagent"))} ${this.theme.fg("accent", this.agent)}${mode} ${this.theme.fg("dim", this.preview)}`;
		const stats =
			this.dispatchedLabel ??
			(this.phase === "done" || this.phase === "failed"
				? `${this.elapsedSeconds().toFixed(1)}s · ${this.toolCount} tools`
				: `${this.elapsedSeconds().toFixed(0)}s · ${this.toolCount} tools`);
		const lines = [truncateToWidth(head, width, "…"), `  ${this.theme.fg("dim", stats)}`];
		if (this.expanded && (this.phase === "done" || this.phase === "failed") && this.output) {
			lines.push("");
			lines.push(...new Markdown(truncateHead(this.output).content, 0, 0, getMarkdownTheme()).render(width));
		}
		return lines;
	}

	invalidate(): void {
		// Passive by design: the framework calls this while propagating an
		// invalidation down the tree. Calling redraw() here would re-enter the
		// propagation (ToolExecutionComponent.invalidate → children → this)
		// and blow the stack; only the card's own frame timer triggers redraw.
	}
}

/** Renders nothing: the result slot must not duplicate the call-slot card. */
class EmptyComponent implements Component {
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

/**
 * Run-mode default by layer: the MAIN agent's subagents detach by default
 * (notifications wake it later), but a subagent's own children always block —
 * a headless child process exits after its turn, so nothing would ever wake
 * it to collect a background result. Explicit background:true inside a child
 * is ignored for the same reason.
 */
export function subagentRunsInBackground(params: { background?: boolean }, depth: number): boolean {
	if (depth > 0) return false;
	return params.background !== false;
}

const subagentsExtension: ExtensionFactory = (pi) => {
	const config = loadConfig();
	const semaphore = new Semaphore(config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
	const depth = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10) || 0;
	// A transcript frozen while the subagent tool was absent keeps it inactive
	// in every later process; ensure it on every run (depth-capped children
	// without the tool get no rescue, and no repair noise either).
	pi.on("before_agent_start", () => {
		ensureSystemToolsActive(pi, ["subagent"]);
	});
	// Background subagents register with the shared background-job registry:
	// completion notifications and the footer running-count are delivered by
	// the background-jobs extension, exactly like backgrounded bash commands.

	pi.registerTool({
		name: "subagent",
		label: "subagent",
		// The status card is the compact surface itself: never fold it into the
		// generic one-liner after completion.
		renderCompact: false,
		description:
			"Delegate ONE clearly parallelizable, self-contained task to an isolated subagent process. Subagents ALWAYS run detached in the background — that is this tool's normal mode, not a special feature or a recent change: the call returns immediately, you keep working or end your reply, and each result wakes you as a task notification. Reserved for genuinely parallel, substantial work — several independent investigations, reviews, or wide mechanical edits; most tasks do not warrant it. " +
			"Subagents have NO conversation context, no persona, and no memory tools: put everything they need into the task text; they see the current project's memory as read-only reference. " +
			"Foreground calls block until done; background: true returns immediately and the result arrives as a task notification that wakes you on the next turn.",
		promptSnippet: "Delegate clearly parallelizable work to isolated subagents",
		promptGuidelines: [
			"Call subagent only for obviously parallel and substantial work (independent searches, reviews, or mechanical edits across many files); for everything else, do the work yourself in this session.",
			"Do not spawn subagents for single quick reads, greps, or minor edits — emit parallel tool calls instead.",
			"Subagents see nothing of this conversation: the task text must carry every fact they need.",
			"Subagents run in the background by default — dispatch, continue other work or end your reply; results arrive as task notifications. Use background: false only when the answer must shape your next sentence.",
		],
		parameters: Type.Object({
			agent: Type.String({
				description: `Agent name (scout, worker, or a definition in ${join(getAgentDir(), "agents")} or ${join(CONFIG_DIR_NAME, "agents")})`,
			}),
			task: Type.String({ description: "Complete, self-contained task description with all needed context" }),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Default true: return immediately, keep working, and the result wakes you as a task notification. Set false only when your very next sentence needs the result",
				}),
			),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for the subagent process (default: current)" }),
			),
		}),
		renderCall(args, theme, context) {
			const agent = args.agent ? String(args.agent) : "";
			const preview = args.task ? (String(args.task).split("\n")[0]?.slice(0, 72) ?? "") : "";
			const background = args.background !== false;
			if (!context.state) context.state = {};
			const state = context.state as { card?: SubagentCard };
			if (!state.card || state.card.agentName !== agent) {
				state.card = new SubagentCard(agent, preview, background, theme, context.invalidate);
			}
			return state.card;
		},
		renderResult(result, options, _theme, context) {
			if (!context.state) context.state = {};
			const state = context.state as { card?: SubagentCard };
			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "(no output)";
			if (!state.card) {
				state.card = new SubagentCard("", "", false, _theme, context.invalidate);
			}
			if (options.isPartial) {
				state.card.update((result.details ?? {}) as { phase?: string; startedAt?: number; toolCount?: number });
			} else {
				const details = (result.details ?? {}) as { toolCount?: number; background?: boolean; id?: string };
				// The card lives in the CALL slot; returning it here too would
				// render it twice. Background dispatches freeze as "dispatched";
				// foreground finishes with the real output stats.
				if (details.background && details.id) state.card.finishDispatched(details.id);
				else state.card.finish(text, result.isError === true, details.toolCount ?? 0);
				state.card.setExpanded(options.expanded);
			}
			return new EmptyComponent();
		},
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			const defs = loadAgentDefs(ctx.cwd);
			const def = defs.find((candidate) => candidate.name === params.agent);
			if (!def) {
				throw new Error(
					`Unknown agent: ${params.agent}. Available: ${defs.map((candidate) => candidate.name).join(", ") || "none"}`,
				);
			}
			const model = def.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
			if (!model)
				throw new Error("No model available: define `model` in the agent definition or set a session model");

			// Default background: the call returns at once and the notification
			// wakes the model; false blocks for reply-shaping results.
			const background = subagentRunsInBackground(params, depth);
			const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
			let liveToolCount = 0;
			const startedAt = Date.now();
			const onToolStart = (): void => {
				liveToolCount += 1;
				onUpdate?.({
					content: [{ type: "text", text: "…" }],
					details: { phase: "running", startedAt, toolCount: liveToolCount },
				});
			};
			const launch = async (): Promise<ChildRun> => {
				const tempDir = mkdtempSync(join(tmpdir(), "neko-sub-"));
				const promptPath = join(tempDir, `${def.name}-prompt.md`);
				const longTask = params.task.length > TASK_ARG_LIMIT;
				const taskPath = longTask ? join(tempDir, `${def.name}-task.md`) : undefined;
				const command = buildChildCommand({
					def,
					task: params.task,
					entryPath: getCliEntryPath(),
					depth,
					promptPath,
					taskPath,
					projectMemory: projectMemoryBlock(cwd),
					modelFallback: model,
					cwd,
				});
				writeFileSync(promptPath, command.prompt, { encoding: "utf8", mode: 0o600 });
				if (longTask && taskPath) writeFileSync(taskPath, params.task, { encoding: "utf8", mode: 0o600 });
				try {
					return await runChildProcess(command, signal, onToolStart);
				} finally {
					rmSync(tempDir, { recursive: true, force: true });
				}
			};

			if (background) {
				const job = registerBackgroundJob({
					sessionId: ctx.sessionManager.getSessionId(),
					kind: "subagent",
					label: `${def.name}: ${params.task.split("\n")[0]?.slice(0, 60) ?? ""}`,
				});
				void semaphore.run(launch).then((run) => {
					finishBackgroundJob(job.id, {
						status: run.exitCode === 0 && !run.error ? "completed" : "failed",
						summary: run.error ? `${run.output}\nError: ${run.error}` : run.output,
						exitCode: run.exitCode,
					});
				});
				return {
					content: [
						{
							type: "text",
							text: `Background subagent started (job ${job.id}) — this is the default mode. Continue with other work or end your reply; a task notification with the result wakes you when it finishes.`,
						},
					],
					details: { id: job.id, agent: def.name, background: true },
				};
			}

			// Foreground still registers (status bar + /tasks) but never
			// notifies: the tool result itself carries the output.
			const job = registerBackgroundJob({
				sessionId: ctx.sessionManager.getSessionId(),
				kind: "subagent",
				label: `${def.name}: ${params.task.split("\n")[0]?.slice(0, 60) ?? ""}`,
				notify: false,
			});
			const heartbeat = setInterval(() => {
				onUpdate?.({
					content: [{ type: "text", text: "…" }],
					details: { phase: "running", startedAt, toolCount: liveToolCount },
				});
			}, 400);
			let run: ChildRun;
			try {
				run = await semaphore.run(launch);
			} finally {
				clearInterval(heartbeat);
			}
			finishBackgroundJob(job.id, {
				status: run.exitCode === 0 && !run.error ? "completed" : "failed",
				summary: run.error ? `${run.output}\nError: ${run.error}` : run.output,
				exitCode: run.exitCode,
			});
			const failed = run.exitCode !== 0 || !!run.error;
			const text = run.error ? `${run.output}\nError: ${run.error}`.trim() : run.output;
			return {
				content: [{ type: "text", text: text || "(no output)" }],
				details: { agent: def.name, exitCode: run.exitCode, toolCount: run.toolCount, usage: run.usage },
				...(failed ? { isError: true } : {}),
			};
		},
	});
};

export default subagentsExtension;
