import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { executeBashWithOperations } from "../../core/bash-executor.ts";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { atomicWrite, readState } from "../../core/storage.ts";
import type { BashOperations } from "../../core/tools/bash.ts";
import { createLocalBashOperations } from "../../core/tools/bash.ts";
import { builtInExtensions } from "../../extensions/index.ts";
import { theme } from "../interactive/theme/theme.ts";
import type { BridgeAgent, BridgeModel, BridgeUiChannel } from "./server.ts";
import { truncateNativeSession } from "./truncate.ts";

/** One native session entry as the bridge sees it for projections and forks. */
export interface NativeEntryInfo {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	created: number;
	modified: number;
	messageCount: number;
	firstMessage: string;
}

/** A native message entry projected into the bridge's history format. */
export interface ProjectedMessage {
	id: string;
	type: "user" | "assistant";
	text: string;
	content?: Array<Record<string, unknown>>;
	time: { created: number };
	/** Frozen background appended at delivery, kept for the UI's own marker. */
	injected?: string;
	[key: string]: unknown;
}

const INJECTED_BLOCK =
	/(?:\n\n(?:<message_time>[\s\S]*?<\/message_time>|<runtime_activity>[\s\S]*?<\/runtime_activity>|<runtime_memory>[\s\S]*?<\/runtime_memory>|<runtime_compensation>[\s\S]*?<\/runtime_compensation>))+\s*$/;

/**
 * Split a persisted user message into what the user typed and the frozen
 * background the bridge appended at delivery time. The injected part is kept
 * (not discarded) so the UI can show it as its own element instead of
 * pretending the user typed it.
 */
export function extractInjectedContext(text: string): { text: string; injected?: string } {
	const match = text.match(INJECTED_BLOCK);
	if (!match) return { text };
	return { text: text.slice(0, match.index), injected: match[0].trim() };
}

/** The user-visible part of a persisted message (injected background removed). */
export function stripInjectedContext(text: string): string {
	return extractInjectedContext(text).text;
}

/** One-line summary of an injected block: which sections, how large. */
export function summarizeInjectedContext(injected: string): string {
	const sizes = (tag: string): number | undefined => {
		const match = injected.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
		return match ? Buffer.byteLength(match[1] ?? "", "utf8") : undefined;
	};
	const parts: string[] = [];
	for (const tag of ["message_time", "runtime_activity", "runtime_memory", "runtime_compensation"]) {
		const bytes = sizes(tag);
		if (bytes === undefined) continue;
		parts.push(tag === "message_time" ? "time" : `${tag.replace("runtime_", "")} ${formatBytes(bytes)}`);
	}
	return parts.length > 0 ? parts.join(" · ") : formatBytes(Buffer.byteLength(injected, "utf8"));
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

/** Project a session file's active branch into bridge history messages. */
export function projectNativeHistory(manager: SessionManager): ProjectedMessage[] {
	const messages: ProjectedMessage[] = [];
	for (const entry of manager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role: string; content: unknown; timestamp?: number } | undefined;
		if (!message) continue;
		const created = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
		if (message.role === "user") {
			const content = message.content;
			const raw =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.flatMap((part) =>
									part && typeof part === "object" && "text" in part && typeof part.text === "string"
										? [part.text]
										: [],
								)
								.join("\n")
						: "";
			// Persisted user text carries the frozen background this bridge
			// appended at delivery. Split it: the bubble shows what the user
			// typed, and `injected` carries the background for a separate
			// marker in the transcript.
			const split = extractInjectedContext(raw);
			messages.push({
				id: entry.id,
				type: "user",
				text: split.text,
				time: { created },
				...(split.injected ? { injected: split.injected } : {}),
			});
		} else if (message.role === "assistant") {
			const content = Array.isArray(message.content) ? message.content : [];
			const parts = content
				.filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
				.map((part) => ({
					type: part.type === "thinking" ? "reasoning" : String(part.type),
					text:
						part.type === "thinking"
							? String(part.thinking ?? "")
							: typeof part.text === "string"
								? part.text
								: "",
				}));
			messages.push({
				id: entry.id,
				type: "assistant",
				text: parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
				content: parts,
				time: { created },
			});
		}
	}
	return messages;
}

export interface CreateBridgeAgentOptions {
	/** Channel the agent's extension UI requests reach the TUI through. */
	ui?: BridgeUiChannel;
}

export async function createBridgeAgent(
	cwd: string,
	selection?: BridgeModel,
	sessionID?: string,
	options?: CreateBridgeAgentOptions,
): Promise<BridgeAgent> {
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
	const model = selection ? modelRuntime.getModel(selection.providerID, selection.id) : undefined;
	if (selection && !model) {
		// A session restored with a model that is no longer configured must
		// still open: fall back to pi's default resolution. The stale id is
		// reported per-run when the run tries to switch to it.
		console.error(
			`[bridge] model ${selection.providerID}/${selection.id} is no longer configured; starting with the default model`,
		);
	}
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noContextFiles: true,
		extensionFactories: builtInExtensions,
	});
	await resourceLoader.reload();
	const pointer = sessionID ? join(agentDir, "sessions", "bridge-backends", `${sessionID}.json`) : undefined;
	const stored = pointer ? readState(pointer) : undefined;
	const sessionFile = typeof stored === "string" && existsSync(stored) ? stored : undefined;
	const sessionManager = sessionFile ? SessionManager.open(sessionFile, undefined, cwd) : SessionManager.create(cwd);
	const { session } = await createAgentSession({
		cwd,
		model,
		modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager,
	});

	// Session-scoped environment (B11): kept per agent and merged into shell
	// spawns only. The bridge process environment is never mutated, so two
	// sessions cannot leak variables into each other.
	let sessionEnvironment: Record<string, string> = {};
	const sessionEnvOperations = (): BashOperations => {
		const base = createLocalBashOperations();
		return {
			exec: (command, execCwd, execOptions) =>
				base.exec(command, execCwd, {
					...execOptions,
					env: { ...process.env, ...sessionEnvironment },
				}),
		};
	};

	/** Bind extension UI requests to the bridge channel (B04). */
	const bindUi = async (
		target: Awaited<ReturnType<typeof createAgentSession>>["session"],
		channel: BridgeUiChannel,
	) => {
		// Interactive-only surfaces (custom components, editor takeover,
		// autocomplete) degrade to no-ops on the bridge; the request/response
		// dialogs are the parts the TUI can actually answer.
		const uiContext: ExtensionUIContext = {
			select: (title, selectOptions, opts) =>
				channel.request({
					kind: "select",
					title,
					options: selectOptions,
					timeoutMs: opts?.timeout,
				}) as Promise<string | undefined>,
			confirm: async (title, message, opts) =>
				Boolean(
					await channel.request({
						kind: "confirm",
						title,
						message,
						timeoutMs: opts?.timeout,
					}),
				),
			input: (title, placeholder, opts) =>
				channel.request({
					kind: "input",
					title,
					placeholder,
					timeoutMs: opts?.timeout,
				}) as Promise<string | undefined>,
			editor: (title, prefill) =>
				channel.request({ kind: "input", title, placeholder: prefill }) as Promise<string | undefined>,
			notify: (message, type) => channel.notify(message, type),
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return theme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "UI not available" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
			custom: async () => undefined as never,
		};
		await target.bindExtensions({ uiContext, mode: "rpc" });
	};

	if (options?.ui) await bindUi(session, options.ui);

	if (pointer) atomicWrite(pointer, JSON.stringify(sessionManager.getSessionFile()));
	return {
		prompt: (text, promptOptions) => session.prompt(text, promptOptions),
		setThinkingLevel: (level) => session.setThinkingLevel(level as never),
		compact: (instructions) => session.compact(instructions),
		exportToHtml: (outputPath) => session.exportToHtml(outputPath),
		exportToJsonl: (outputPath) => session.exportToJsonl(outputPath),
		getSessionStats: () => session.getSessionStats(),
		reload: () => session.reload(),
		truncate: (entryId) => truncateNativeSession(session, entryId),
		getBranchEntryIds: () => sessionManager.getBranch().map((entry) => entry.id),
		getSessionId: () => sessionManager.getSessionId(),
		getMessageEntryId: (message) => session.getEntryIdForMessage(message as never),
		listMcpServers: () => {
			// pi's MCP registry is per-extension; the bridge surfaces them via
			// the resource loader's diagnostics for now (full MCP bridging is P2).
			return [];
		},
		listSkills: () => {
			const { skills } = resourceLoader.getSkills();
			return skills.map((skill) => ({
				id: skill.name,
				name: skill.name,
				description: skill.description,
				source: typeof skill.sourceInfo === "string" ? skill.sourceInfo : "local",
			}));
		},
		listSlashCommands: () => {
			const { prompts } = resourceLoader.getPrompts();
			return prompts.map((prompt) => ({
				name: prompt.name,
				description: prompt.description,
				source: "prompt",
			}));
		},
		listNativeSessions: async (listCwd) => {
			const sessions = await SessionManager.list(listCwd);
			return sessions.map((info) => ({
				id: info.id,
				path: info.path,
				cwd: info.cwd,
				name: info.name,
				created: info.created.getTime(),
				modified: info.modified.getTime(),
				messageCount: info.messageCount,
				firstMessage: info.firstMessage,
			}));
		},
		openNativeSession: async (sessionFilePath) => {
			const manager = SessionManager.open(sessionFilePath, undefined, cwd);
			const { session: nativeSession } = await createAgentSession({
				cwd,
				model,
				modelRuntime,
				settingsManager,
				resourceLoader,
				sessionManager: manager,
			});
			if (options?.ui) await bindUi(nativeSession, options.ui);
			return {
				id: manager.getSessionId(),
				file: manager.getSessionFile() ?? sessionFilePath,
				projection: projectNativeHistory(manager),
				backend: {
					truncate: (entryId) => truncateNativeSession(nativeSession, entryId),
					getSessionId: () => manager.getSessionId(),
					getMessageEntryId: (message) => nativeSession.getEntryIdForMessage(message as never),
					resolveEntryId: (messageId) => manager.getBranch().find((entry) => entry.id === messageId)?.id,
					prompt: (text, promptOptions) => nativeSession.prompt(text, promptOptions),
					subscribe: (listener) => nativeSession.subscribe(listener),
					abort: () => nativeSession.abort(),
					waitForIdle: () => nativeSession.waitForIdle(),
					dispose: () => nativeSession.dispose(),
					async setModel(next) {
						if (nativeSession.model?.provider === next.providerID && nativeSession.model.id === next.id) return;
						const resolved = modelRuntime.getModel(next.providerID, next.id);
						if (!resolved) throw new Error(`Model not found: ${next.providerID}/${next.id}`);
						await nativeSession.setModel(resolved);
					},
				} as BridgeAgent,
			};
		},
		forkSession: async (entryId) => {
			// Fork at the native session-file level: the new file carries the
			// active branch up to (and including) the boundary entry, or the
			// full branch when no boundary is given.
			const sourcePath = sessionManager.getSessionFile();
			if (!sourcePath) throw new Error("No session file to fork from");
			const targetCwd = sessionManager.getCwd();
			const forked =
				entryId === undefined
					? SessionManager.forkFrom(sourcePath, targetCwd)
					: SessionManager.forkFromEntry(sourcePath, targetCwd, entryId);
			return {
				id: forked.getSessionId(),
				file: forked.getSessionFile() ?? "",
				projection: projectNativeHistory(forked),
			};
		},
		resolveEntryId: (messageId) => {
			// Bridge message IDs map to native entry IDs through the session
			// branch: user messages on the current path have stable entry IDs.
			const branch = sessionManager.getBranch();
			for (const entry of branch) {
				if (entry.type === "message" && entry.id === messageId) return entry.id;
			}
			// Bridge-generated IDs (msg_*) have no native counterpart.
			return messageId.startsWith("msg_") ? undefined : messageId;
		},
		setEnvironment: async (variables) => {
			sessionEnvironment = { ...variables };
		},
		executeShell: async (command, shellOptions) => {
			// pi's own async bash pipeline: streams, cancels through the signal,
			// and never blocks the bridge's HTTP loop (B06).
			const result = await executeBashWithOperations(command, sessionManager.getCwd(), sessionEnvOperations(), {
				signal: shellOptions?.signal,
			});
			return {
				stdout: result.output,
				stderr: "",
				exitCode: result.exitCode ?? 1,
				cancelled: result.cancelled,
				truncated: result.truncated,
			};
		},
		subscribe: (listener) => session.subscribe(listener),
		abort: () => session.abort(),
		waitForIdle: () => session.waitForIdle(),
		dispose: () => session.dispose(),
		async setModel(next) {
			if (session.model?.provider === next.providerID && session.model.id === next.id) return;
			const resolved = modelRuntime.getModel(next.providerID, next.id);
			if (!resolved) throw new Error(`Model not found: ${next.providerID}/${next.id}`);
			await session.setModel(resolved);
		},
	};
}
