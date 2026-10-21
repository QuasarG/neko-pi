/**
 * HTTP bridge that presents a subset of the opencode server protocol on top
 * of pi's agent core, so the vendored opencode TUI can run unmodified.
 *
 * Current surface: SSE event stream (server.connected handshake), boot
 * endpoints, model catalog from ~/.neko_pi/models.json, and a persistent
 * session layer so the composer can submit. Unknown GET /api/* routes fall
 * back to the shared location-envelope stub and are logged for triage.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { getModelsPath } from "../../config.ts";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import { finishInit, getInitDraft, saveInitDraft } from "../../core/onboarding.ts";
import { atomicWrite } from "../../core/storage.ts";
import type { PersonaStatus } from "./persona.ts";
import { getPersonaFiles, type PersonaFile } from "./persona-files.ts";

export interface BridgeModel {
	providerID: string;
	id: string;
}

export interface BridgeAgent extends Pick<AgentSession, "prompt" | "subscribe" | "abort" | "dispose" | "waitForIdle"> {
	setModel(model: BridgeModel): Promise<void>;
}

export interface BridgeOptions {
	readonly port?: number;
	readonly host?: string;
	readonly onLog?: (line: string) => void;
	/**
	 * Location the TUI considers default. Requests without a location query
	 * mean "the TUI process cwd"; responding with any other directory makes
	 * the client file the data under a mismatched location key.
	 */
	readonly defaultDirectory?: string;
	readonly modelsPath?: string;
	readonly stateDir?: string;
	readonly createAgent?: (cwd: string, model?: BridgeModel, sessionID?: string) => Promise<BridgeAgent>;
	readonly personaStatus?: () => PersonaStatus;
	readonly personaFiles?: (directory: string) => PersonaFile[];
}

interface SseClient {
	res: ServerResponse;
}

interface BridgeSession {
	id: string;
	agent: string;
	model?: BridgeModel;
	directory: string;
	title: string;
	created: number;
	updated: number;
	messages: Array<{ id: string; role: "user"; text: string; time: number; delivery: "steer" | "queue" }>;
	history: Array<Record<string, unknown>>;
	backend?: Promise<BridgeAgent>;
	run?: Promise<void>;
	seq: number;
	idle?: number;
	viewed?: number;
	outcome?: "succeeded" | "failed" | "interrupted";
	archived?: number;
	aborted?: boolean;
}

function readBody(req: IncomingMessage): Promise<any> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {});
			} catch {
				resolve({});
			}
		});
	});
}

function loadPiModels(modelsPath: string): Array<Record<string, unknown>> {
	const models: Array<Record<string, unknown>> = [];
	try {
		const config = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
			providers?: Record<
				string,
				{ models?: Array<{ id?: string; name?: string; context_window?: number; max_tokens?: number }> }
			>;
		};
		for (const [providerID, provider] of Object.entries(config.providers ?? {})) {
			for (const model of provider.models ?? []) {
				if (!model.id) continue;
				models.push({
					id: model.id,
					modelID: model.id,
					providerID,
					name: model.name ?? model.id,
					capabilities: { tools: true, input: ["text"], output: ["text"] },
					variants: [],
					time: { released: 0 },
					cost: [],
					status: "active",
					enabled: true,
					limit: { context: model.context_window ?? 200000, output: model.max_tokens ?? 8192 },
				});
			}
		}
	} catch {
		// No models.json: the model picker stays empty but the TUI still boots.
	}
	return models;
}

export class TuiBridge {
	private server: Server | undefined;
	private sseClients = new Set<SseClient>();
	private eventSeq = 0;
	private sessions = new Map<string, BridgeSession>();
	private models: Array<Record<string, unknown>>;
	private readonly defaultDirectory: string;
	private readonly log: (line: string) => void;
	private readonly createAgent: BridgeOptions["createAgent"];
	private closed = false;
	private readonly stateDir: string | undefined;
	private readonly personaStatus: BridgeOptions["personaStatus"];
	private readonly personaFiles: NonNullable<BridgeOptions["personaFiles"]>;

	constructor(options: BridgeOptions = {}) {
		this.personaFiles = options.personaFiles ?? (() => getPersonaFiles({}));
		this.stateDir = options.stateDir;
		if (this.stateDir && existsSync(this.stateDir)) {
			for (const file of readdirSync(this.stateDir)) {
				if (!file.endsWith(".json")) continue;
				const saved = JSON.parse(readFileSync(join(this.stateDir, file), "utf8")) as BridgeSession;
				if (
					!saved ||
					typeof saved.id !== "string" ||
					!/^[a-zA-Z0-9_-]+$/.test(saved.id) ||
					typeof saved.directory !== "string" ||
					!Array.isArray(saved.history) ||
					!Array.isArray(saved.messages) ||
					!Number.isFinite(saved.created) ||
					!Number.isFinite(saved.updated)
				)
					throw new Error(`Invalid saved session: ${file}`);
				this.sessions.set(saved.id, {
					...saved,
					backend: undefined,
					run: undefined,
					outcome: saved.idle ? saved.outcome : "interrupted",
				});
			}
		}
		this.personaStatus = options.personaStatus;
		this.createAgent = options.createAgent;
		this.models = loadPiModels(options.modelsPath ?? getModelsPath());
		this.defaultDirectory = options.defaultDirectory ?? process.cwd();
		this.log = options.onLog ?? ((line) => console.error(`[bridge] ${line}`));
	}

	private persist(session: BridgeSession): void {
		if (!this.stateDir) return;
		const { backend: _backend, run: _run, ...saved } = session;
		atomicWrite(join(this.stateDir, `${session.id}.json`), JSON.stringify(saved));
	}

	listen(port = 0, host = "127.0.0.1"): Promise<number> {
		this.server = createServer((req, res) => {
			void this.handle(req, res).catch((error: unknown) => {
				this.json(res, 500, { message: error instanceof Error ? error.message : String(error) });
			});
		});
		return new Promise((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(port, host, () => {
				const address = this.server!.address();
				resolve(typeof address === "object" && address ? address.port : port);
			});
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled(
			[...this.sessions.values()].map(async (session) => {
				if (!session.backend) return;
				const backend = await session.backend;
				await backend.abort();
				await session.run;
				backend.dispose();
			}),
		);
		for (const client of this.sseClients) client.res.end();
		this.sseClients.clear();
		await new Promise<void>((resolve) => this.server?.close(() => resolve()));
	}

	/** Push an opencode-shaped event to every connected TUI. */
	publish(event: Record<string, unknown>): void {
		const payload = `data: ${JSON.stringify(event)}\n\n`;
		for (const client of this.sseClients) client.res.write(payload);
	}

	private json(res: ServerResponse, status: number, body: unknown): void {
		const payload = JSON.stringify(body);
		res.writeHead(status, { "content-type": "application/json" });
		res.end(payload);
	}

	private emit(session: BridgeSession, type: string, data: Record<string, unknown>): void {
		const id = this.nextID("evt");
		const created = Date.now();
		const durable = type.endsWith(".delta")
			? undefined
			: {
					aggregateID: session.id,
					seq: ++session.seq,
					version: type === "session.tool.success" || type === "session.tool.failed" ? 2 : 1,
				};
		this.publish({
			id,
			created,
			type,
			location: { directory: session.directory },
			durable,
			data: { sessionID: session.id, ...data },
		});
		if (type.startsWith("session.execution.") && type !== "session.execution.started") {
			session.history.push({
				id: id.replace("evt_", "msg_"),
				type: "idle",
				outcome: session.outcome,
				error: data.error,
				time: { created },
			});
		}
	}

	private nextID(prefix: "evt" | "msg"): string {
		const time = (BigInt(Date.now()) * 0x1000n + BigInt(++this.eventSeq % 0x1000)).toString(16).slice(-12);
		return `${prefix}_${time}${randomUUID().replaceAll("-", "").slice(0, 14)}`;
	}

	private startRun(session: BridgeSession): void {
		if (session.run || this.closed) return;
		session.run = this.runPending(session).finally(() => {
			session.run = undefined;
		});
	}

	private async runPending(session: BridgeSession): Promise<void> {
		while (session.messages.length && !this.closed) {
			const input = session.messages.shift()!;
			session.idle = undefined;
			session.aborted = false;
			session.history.push({ id: input.id, type: "user", text: input.text, time: { created: input.time } });
			this.emit(session, "session.inbox.delivered", { inboxID: input.id });
			this.emit(session, "session.execution.started", {});
			this.persist(session);
			let unsubscribe: (() => void) | undefined;
			let failure: string | undefined;
			let assistant:
				| {
						id: string;
						content: Array<Record<string, unknown>>;
						time: { created: number; completed?: number };
						[key: string]: unknown;
				  }
				| undefined;
			const parts = new Map<number, { type: "text" | "reasoning"; text: string }>();
			const tools = new Map<
				string,
				{ assistantMessageID: string; part: Record<string, unknown>; input: Record<string, unknown> }
			>();
			const onEvent = (event: AgentSessionEvent) => {
				if (event.type === "tool_execution_start" && assistant) {
					const input: Record<string, unknown> = event.args;
					const part = {
						type: "tool",
						id: event.toolCallId,
						name: event.toolName,
						executed: true,
						state: { status: "running", input, metadata: {} },
						time: { created: Date.now(), ran: Date.now() },
					};
					assistant.content.push(part);
					tools.set(event.toolCallId, { assistantMessageID: assistant.id, part, input });
					this.emit(session, "session.tool.input.started", {
						assistantMessageID: assistant.id,
						id: event.toolCallId,
						name: event.toolName,
					});
					this.emit(session, "session.tool.called", {
						assistantMessageID: assistant.id,
						id: event.toolCallId,
						input,
						executed: true,
					});
				}
				if (event.type === "tool_execution_end") {
					const tool = tools.get(event.toolCallId);
					if (!tool) return;
					const result: unknown = event.result;
					const raw =
						result && typeof result === "object" && "content" in result && Array.isArray(result.content)
							? result.content
							: [];
					const text = raw
						.flatMap((item: unknown) =>
							item && typeof item === "object" && "text" in item && typeof item.text === "string"
								? [item.text]
								: [],
						)
						.join("\n");
					const content = [{ type: "text", text: text || "Tool completed" }];
					const error = { type: "tool", message: text || "Tool execution failed" };
					tool.part.state = event.isError
						? { status: "error", input: tool.input, error, content }
						: { status: "completed", input: tool.input, content };
					tool.part.time = { created: Date.now(), completed: Date.now() };
					this.emit(session, event.isError ? "session.tool.failed" : "session.tool.success", {
						assistantMessageID: tool.assistantMessageID,
						id: event.toolCallId,
						content,
						executed: true,
						...(event.isError ? { error } : {}),
					});
				}
				if (event.type === "message_start" && event.message.role === "assistant") {
					parts.clear();
					assistant = {
						id: this.nextID("msg"),
						type: "assistant",
						agent: session.agent,
						model: session.model,
						content: [],
						time: { created: Date.now() },
					};
					session.history.push(assistant);
					this.emit(session, "session.step.started", {
						assistantMessageID: assistant.id,
						agent: session.agent,
						model: session.model,
						started: assistant.time.created,
					});
				}
				if (event.type === "message_update" && assistant) {
					const delta = event.assistantMessageEvent;
					if (delta.type !== "text_delta" && delta.type !== "thinking_delta") return;
					const type = delta.type === "text_delta" ? "text" : "reasoning";
					let part = parts.get(delta.contentIndex);
					if (!part) {
						part = { type, text: "" };
						parts.set(delta.contentIndex, part);
						assistant.content.push(part);
						this.emit(session, `session.${type}.started`, {
							assistantMessageID: assistant.id,
							ordinal: delta.contentIndex,
						});
					}
					part.text += delta.delta;
					this.emit(session, `session.${type}.delta`, {
						assistantMessageID: assistant.id,
						ordinal: delta.contentIndex,
						delta: delta.delta,
					});
				}
				if (event.type === "message_end" && event.message.role === "assistant" && assistant) {
					for (const [ordinal, part] of event.message.content.entries()) {
						if (part.type !== "text" && part.type !== "thinking") continue;
						const type = part.type === "text" ? "text" : "reasoning";
						const text = part.type === "text" ? part.text : part.thinking;
						if (!parts.has(ordinal)) {
							assistant.content.push({ type, text });
							this.emit(session, `session.${type}.started`, { assistantMessageID: assistant.id, ordinal });
						} else parts.get(ordinal)!.text = text;
						this.emit(session, `session.${type}.ended`, { assistantMessageID: assistant.id, ordinal, text });
					}
					assistant.time.completed = Date.now();
					const usage = event.message.usage;
					const tokens = {
						input: usage.input,
						output: usage.output,
						reasoning: 0,
						cache: { read: usage.cacheRead, write: usage.cacheWrite },
					};
					assistant.finish =
						event.message.stopReason === "toolUse"
							? "tool-calls"
							: event.message.stopReason === "aborted"
								? "error"
								: event.message.stopReason;
					assistant.tokens = tokens;
					assistant.cost = usage.cost.total;
					if (event.message.stopReason === "error")
						failure = event.message.errorMessage ?? "Provider request failed";
					this.emit(session, "session.step.ended", {
						assistantMessageID: assistant.id,
						finish: assistant.finish,
						cost: assistant.cost,
						tokens,
					});
				}
			};
			try {
				if (!this.createAgent) throw new Error("Pi backend is not configured");
				session.backend ??= this.createAgent(session.directory, session.model, session.id);
				const backend = await session.backend;
				if (this.closed) return;
				if (session.model) await backend.setModel(session.model);
				unsubscribe = backend.subscribe(onEvent);
				if (!session.aborted) await backend.prompt(input.text);
				await backend.waitForIdle();
				if (failure) throw new Error(failure);
				session.outcome = session.aborted ? "interrupted" : "succeeded";
				this.emit(
					session,
					session.aborted ? "session.execution.interrupted" : "session.execution.succeeded",
					session.aborted ? { reason: "user" } : {},
				);
			} catch (error) {
				session.outcome = "failed";
				this.emit(session, "session.execution.failed", {
					error: { type: "pi", message: error instanceof Error ? error.message : String(error) },
				});
			} finally {
				unsubscribe?.();
				session.idle = session.updated = Date.now();
				this.persist(session);
			}
		}
	}

	private sessionInfo(id: string): Record<string, unknown> {
		const session = this.sessions.get(id)!;
		return {
			id: session.id,
			projectID: "pi",
			agent: session.agent,
			model: session.model,
			location: { directory: session.directory },
			title: session.title,
			cost: 0,
			tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
			outcome: session.outcome,
			time: {
				created: session.created,
				updated: session.updated,
				idle: session.idle,
				viewed: session.viewed,
				archived: session.archived,
			},
		};
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://bridge.local");
		const path = url.pathname;
		const directory = url.searchParams.get("location[directory]") ?? this.defaultDirectory;
		this.log(`${req.method} ${path}${url.search}`);
		if (req.method === "GET" && path === "/api/neko/sessions") {
			this.json(res, 200, {
				sessions: [...this.sessions.values()]
					.filter((session) => !session.archived)
					.toSorted((a, b) => b.updated - a.updated)
					.map((session) => ({
						id: session.id,
						title: session.title,
						directory: session.directory,
						updated: session.updated,
						running: Boolean(session.run),
						outcome: session.outcome,
					})),
			});
			return;
		}
		if (req.method === "GET" && path === "/api/neko/files") {
			this.json(res, 200, { files: this.personaFiles(directory) });
			return;
		}
		if (path === "/api/neko/init") {
			if (req.method === "GET") {
				this.json(res, 200, getInitDraft());
				return;
			}
			if (req.method === "PUT" || req.method === "POST") {
				if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
					this.json(res, 403, { message: "Foreign origin" });
					return;
				}
				if ([...this.sessions.values()].some((session) => session.run)) {
					this.json(res, 409, { message: "Wait for running conversations to finish before configuring identity" });
					return;
				}
				try {
					const draft = await readBody(req);
					if (req.method === "PUT") saveInitDraft(draft);
					else {
						finishInit(draft);
						for (const session of this.sessions.values()) {
							if (session.backend) (await session.backend).dispose();
							session.backend = undefined;
						}
					}
					this.json(res, 200, { saved: true });
				} catch (error) {
					this.json(res, 400, { message: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
		}
		if (req.method === "GET" && path === "/api/neko/status") {
			this.json(
				res,
				200,
				this.personaStatus?.() ?? {
					name: "Neko",
					identityReady: false,
					voiceReady: false,
					memoryFiles: 0,
					lintConfigured: false,
				},
			);
			return;
		}

		if (path === "/api/event") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
			});
			// The client's handshake requires the first frame to be server.connected.
			this.eventSeq += 1;
			res.write(
				`data: ${JSON.stringify({ id: `evt_bridge_${this.eventSeq}`, type: "server.connected", data: {} })}\n\n`,
			);
			const client: SseClient = { res };
			this.sseClients.add(client);
			// Keepalive comment every 15s matches the client's idle timeout budget.
			const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
			req.on("close", () => {
				clearInterval(keepalive);
				this.sseClients.delete(client);
			});
			return;
		}

		if (req.method === "GET" && path === "/api/location") {
			this.json(res, 200, { directory, project: { id: "pi", directory, canonical: directory } });
			return;
		}

		if (req.method === "GET" && path === "/api/config") {
			this.json(res, 200, []);
			return;
		}

		if (req.method === "GET" && path === "/api/info") {
			this.json(res, 200, {
				version: "1.3.0",
				pid: process.pid,
				urls: [`http://127.0.0.1:${url.port}`],
				paths: { tmp: "/tmp" },
			});
			return;
		}

		if (req.method === "GET" && path === "/api/agent") {
			this.json(res, 200, {
				location: { directory, worktree: directory },
				data: [
					{
						id: "build",
						name: this.personaStatus?.().name ?? "Neko",
						mode: "primary",
						hidden: false,
						permissions: [],
						request: { settings: {}, headers: {}, body: {} },
					},
				],
			});
			return;
		}

		if (req.method === "GET" && path === "/api/vcs") {
			this.json(res, 200, { location: { directory, worktree: directory }, data: { branch: "main" } });
			return;
		}

		if (req.method === "GET" && path === "/api/model") {
			this.json(res, 200, { location: { directory, worktree: directory }, data: this.models });
			return;
		}

		if (req.method === "GET" && path === "/api/model/default") {
			const fallback = this.models.find((m) => String(m.id).includes("flash")) ?? this.models[0];
			this.json(res, 200, { location: { directory }, data: fallback });
			return;
		}

		if (req.method === "GET" && path === "/api/session") {
			const search = url.searchParams.get("search")?.toLocaleLowerCase();
			const filterDirectory = url.searchParams.get("directory");
			const limit = Number(url.searchParams.get("limit") ?? 100);
			const sessions = [...this.sessions.values()]
				.filter(
					(session) =>
						(!session.archived || url.searchParams.get("archived") === "true") &&
						(!search || session.title.toLocaleLowerCase().includes(search)) &&
						(!filterDirectory || session.directory === filterDirectory),
				)
				.toSorted((a, b) =>
					url.searchParams.get("order") === "asc" ? a.updated - b.updated : b.updated - a.updated,
				);
			this.json(res, 200, {
				data: sessions
					.slice(0, Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100)
					.map((s) => this.sessionInfo(s.id)),
				cursor: {},
			});
			return;
		}

		if (req.method === "GET" && path === "/api/session/active") {
			this.json(res, 200, {
				data: Object.fromEntries(
					[...this.sessions.values()].filter((s) => s.run).map((s) => [s.id, { type: "running" }]),
				),
			});
			return;
		}

		if (req.method === "POST" && path === "/api/session") {
			await readBody(req).then((body) => {
				const id = body.id ?? `ses_${Math.random().toString(36).slice(2, 10)}`;
				if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
					this.json(res, 400, { message: "Invalid session ID" });
					return;
				}
				if (this.sessions.has(id)) {
					this.json(res, 200, { data: this.sessionInfo(id) });
					return;
				}
				const now = Date.now();
				this.sessions.set(id, {
					id,
					agent: body.agent ?? "build",
					model: body.model,
					directory: body.location?.directory ?? directory,
					title: body.title ?? "New session",
					created: now,
					updated: now,
					idle: now,
					messages: [],
					history: [],
					seq: 0,
				});
				this.persist(this.sessions.get(id)!);
				this.json(res, 200, { data: this.sessionInfo(id) });
			});
			return;
		}

		const sessionMatch = path.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
		if (sessionMatch) {
			const session = this.sessions.get(sessionMatch[1]!);
			const sub = sessionMatch[2] ?? "";
			// Missing sessions must not fall through to the list-shaped GET stub.
			if (!session) {
				this.json(res, 404, {
					_tag: "SessionNotFoundError",
					sessionID: sessionMatch[1],
					message: `Session not found: ${sessionMatch[1]}`,
				});
				return;
			}
			if (req.method === "GET" && session && sub === "") {
				this.json(res, 200, { data: this.sessionInfo(session.id) });
				return;
			}
			if (req.method === "PATCH" && sub === "") {
				const body = await readBody(req);
				if (
					(body.title !== undefined && typeof body.title !== "string") ||
					(body.archived !== undefined && typeof body.archived !== "boolean")
				) {
					this.json(res, 400, { message: "Invalid session update" });
					return;
				}
				if (body.title !== undefined) {
					session.title =
						body.title.trim() ||
						String(session.history.find((message) => message.type === "user")?.text ?? "New session").slice(
							0,
							80,
						);
					this.emit(session, "session.renamed", { title: session.title });
				}
				if (body.archived !== undefined) {
					session.archived = body.archived ? Date.now() : undefined;
					this.emit(session, body.archived ? "session.archived" : "session.unarchived", {});
				}
				session.updated = Date.now();
				this.persist(session);
				res.writeHead(204);
				res.end();
				return;
			}
			if (req.method === "DELETE" && sub === "") {
				if (session.run) {
					this.json(res, 409, { message: "Stop the running session before deleting it" });
					return;
				}
				if (session.backend) (await session.backend).dispose();
				if (this.stateDir) {
					const archive = join(this.stateDir, "deleted");
					mkdirSync(archive, { recursive: true, mode: 0o700 });
					renameSync(join(this.stateDir, `${session.id}.json`), join(archive, `${session.id}-${Date.now()}.json`));
				}
				this.emit(session, "session.deleted", {});
				this.sessions.delete(session.id);
				res.writeHead(204);
				res.end();
				return;
			}
			if (req.method === "POST" && sub === "/view") {
				const body = await readBody(req);
				if (typeof body.idle !== "number" || !Number.isFinite(body.idle) || body.idle < 0) {
					this.json(res, 400, { message: "Invalid idle watermark" });
					return;
				}
				if (session.idle !== undefined) {
					session.viewed = Math.max(session.viewed ?? 0, Math.min(body.idle, session.idle));
					this.persist(session);
					this.emit(session, "session.viewed", { idle: session.viewed });
				}
				res.writeHead(204);
				res.end();
				return;
			}
			if (req.method === "POST" && sub === "/interrupt") {
				const interrupted = Boolean(session.run);
				session.aborted = true;
				void (session.backend ? session.backend.then((backend) => backend.abort()) : Promise.resolve())
					.then(() => this.json(res, 200, { interrupted }))
					.catch((error: unknown) =>
						this.json(res, 500, { message: error instanceof Error ? error.message : String(error) }),
					);
				return;
			}
			if (req.method === "GET" && session && sub === "/message") {
				this.json(res, 200, { data: session.history, cursor: {} });
				return;
			}
			if (req.method === "GET" && session && sub === "/inbox") {
				this.json(res, 200, {
					data: session.messages.map((message) => ({
						id: message.id,
						sessionID: session.id,
						time: { created: message.time },
						type: "user",
						payload: { text: message.text },
						delivery: message.delivery,
					})),
				});
				return;
			}
			if (req.method === "POST" && session && (sub === "/model" || sub === "/agent")) {
				await readBody(req).then((body) => {
					if (sub === "/model") session.model = body.model;
					else session.agent = body.agent;
					session.updated = Date.now();
					this.persist(session);
					res.writeHead(204);
					res.end();
				});
				return;
			}
			if (req.method === "POST" && session && sub === "/prompt") {
				await readBody(req).then((body) => {
					const text = typeof body.text === "string" ? body.text : "";
					const id = body.id ?? `msg_${Math.random().toString(36).slice(2, 10)}`;
					const now = Date.now();
					if (session.title === "New session" && text.trim()) {
						session.title = Array.from(text.trim().replace(/\s+/g, " ")).slice(0, 48).join("");
						this.emit(session, "session.renamed", { title: session.title });
					}
					session.messages.push({
						id,
						role: "user",
						text,
						delivery: body.delivery ?? "steer",
						time: now,
					});
					session.updated = now;
					this.persist(session);
					this.json(res, 200, {
						data: {
							id,
							sessionID: session.id,
							time: { created: session.updated },
							type: "user",
							payload: { text },
							delivery: body.delivery ?? "steer",
						},
					});
					this.startRun(session);
				});
				return;
			}
		}

		if (req.method === "GET" && path === "/api/experimental/migration/v1") {
			// pi sessions have no V1 history to migrate.
			this.json(res, 200, { status: "completed" });
			return;
		}

		if (req.method === "GET" && path === "/api/fs/list") {
			const base = url.searchParams.get("path") ? join(directory, url.searchParams.get("path")!) : directory;
			const entries = existsSync(base)
				? readdirSync(base, { withFileTypes: true }).map((entry) => ({
						path: entry.name,
						type: entry.isDirectory() ? "directory" : "file",
					}))
				: [];
			this.json(res, 200, { location: { directory, worktree: directory }, data: entries });
			return;
		}

		if (req.method === "GET" && path === "/api/plugin") {
			this.json(res, 200, { location: { directory, worktree: directory }, data: [] });
			return;
		}

		if (req.method === "GET" && path === "/api/project") {
			this.json(res, 200, []);
			return;
		}

		// Generic stub: every opencode list endpoint shares the location envelope.
		if (req.method === "GET" && path.startsWith("/api/")) {
			this.log(`STUB ${req.method} ${path}`);
			this.json(res, 200, { location: { directory, worktree: directory }, data: [] });
			return;
		}

		// Not implemented yet: log the request so the gap list is enumerable.
		this.log(`MISSING ${req.method} ${path}`);
		this.json(res, 404, { error: "not-implemented", path });
	}
}
