/**
 * HTTP bridge that presents a subset of the opencode server protocol on top
 * of pi's agent core, so the vendored opencode TUI can run unmodified.
 *
 * Current surface: SSE event stream (server.connected handshake), boot
 * endpoints, model catalog from ~/.pi/agent/models.json, and an in-memory
 * session layer so the composer can submit. Unknown GET /api/* routes fall
 * back to the shared location-envelope stub and are logged for triage.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

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
}

interface SseClient {
	res: ServerResponse;
}

interface BridgeSession {
	id: string;
	title: string;
	created: number;
	updated: number;
	messages: Array<{ id: string; role: "user"; text: string; time: number }>;
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

function loadPiModels(): Array<Record<string, unknown>> {
	const modelsPath = join(homedir(), ".pi", "agent", "models.json");
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
					id: `${providerID}/${model.id}`,
					modelID: model.id,
					providerID,
					name: model.name ?? model.id,
					capabilities: { tools: true, input: ["text"], output: ["text"] },
					variants: [],
					time: { released: 0 },
					cost: [],
					status: "active",
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
	private models = loadPiModels();
	private readonly defaultDirectory: string;
	private readonly log: (line: string) => void;

	constructor(options: BridgeOptions = {}) {
		this.defaultDirectory = options.defaultDirectory ?? process.cwd();
		this.log = options.onLog ?? ((line) => console.error(`[bridge] ${line}`));
	}

	listen(port = 0, host = "127.0.0.1"): Promise<number> {
		this.server = createServer((req, res) => {
			void this.handle(req, res);
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

	private sessionInfo(id: string): Record<string, unknown> {
		const session = this.sessions.get(id)!;
		return {
			id: session.id,
			projectID: "pi",
			title: session.title,
			cost: 0,
			tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
			time: { created: session.created, updated: session.updated },
		};
	}

	private handle(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", "http://bridge.local");
		const path = url.pathname;
		const directory = url.searchParams.get("location[directory]") ?? this.defaultDirectory;
		this.log(`${req.method} ${path}${url.search}`);

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
			this.json(res, 200, { location: { directory, worktree: directory, vcs: "git" } });
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
						name: "Build",
						mode: "primary",
						hidden: false,
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
			this.json(res, 200, { location: { directory, worktree: directory }, data: fallback });
			return;
		}

		if (req.method === "GET" && path === "/api/session") {
			this.json(res, 200, { data: [...this.sessions.values()].map((s) => this.sessionInfo(s.id)), cursor: {} });
			return;
		}

		if (req.method === "GET" && path === "/api/session/active") {
			this.json(res, 200, { sessionID: undefined });
			return;
		}

		if (req.method === "POST" && path === "/api/session") {
			void readBody(req).then((body) => {
				const id = `ses_${Math.random().toString(36).slice(2, 10)}`;
				const now = Date.now();
				this.sessions.set(id, { id, title: body.title ?? "New session", created: now, updated: now, messages: [] });
				this.json(res, 200, this.sessionInfo(id));
			});
			return;
		}

		const sessionMatch = path.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
		if (sessionMatch && !["/active"].includes(sessionMatch[1]!)) {
			const session = this.sessions.get(sessionMatch[1]!);
			const sub = sessionMatch[2] ?? "";
			if (req.method === "GET" && session && sub === "") {
				this.json(res, 200, { data: this.sessionInfo(session.id) });
				return;
			}
			if (req.method === "GET" && session && sub === "/message") {
				this.json(res, 200, { data: [] });
				return;
			}
			if (req.method === "POST" && session && sub === "/prompt") {
				void readBody(req).then((body) => {
					const text = typeof body.text === "string" ? body.text : "";
					session.messages.push({
						id: `msg_${Math.random().toString(36).slice(2, 10)}`,
						role: "user",
						text,
						time: Date.now(),
					});
					session.updated = Date.now();
					this.json(res, 200, { data: { type: "user", payload: { text }, delivery: "queue" } });
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
