/**
 * HTTP bridge that presents a subset of the opencode server protocol on top
 * of pi's agent core, so the vendored opencode TUI can run unmodified.
 *
 * Phase 1 (this file): request logging + SSE event stream + stubbed boot
 * endpoints. Every unknown route logs loudly and returns a structured 404 so
 * the TUI's needs can be enumerated by simply running it.
 */

import { existsSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

export interface BridgeOptions {
	readonly port?: number;
	readonly host?: string;
	readonly onLog?: (line: string) => void;
}

interface SseClient {
	res: ServerResponse;
}

export class TuiBridge {
	private server: Server | undefined;
	private sseClients = new Set<SseClient>();
	private eventSeq = 0;
	private readonly log: (line: string) => void;

	constructor(options: BridgeOptions = {}) {
		this.log = options.onLog ?? ((line) => console.error(`[bridge] ${line}`));
	}

	listen(port = 0, host = "127.0.0.1"): Promise<number> {
		this.server = createServer((req, res) => this.handle(req, res));
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

	private handle(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", "http://bridge.local");
		const path = url.pathname;
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
			this.json(res, 200, { location: { directory: process.cwd(), worktree: process.cwd(), vcs: "git" } });
			return;
		}

		if (req.method === "GET" && path === "/api/session") {
			this.json(res, 200, { data: [], cursor: {} });
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
			const directory = url.searchParams.get("location[directory]") ?? process.cwd();
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
			const directory = url.searchParams.get("location[directory]") ?? process.cwd();
			this.json(res, 200, { location: { directory, worktree: directory }, data: { branch: "main" } });
			return;
		}

		if (req.method === "GET" && path === "/api/model") {
			const directory = url.searchParams.get("location[directory]") ?? process.cwd();
			this.json(res, 200, { location: { directory, worktree: directory }, data: [] });
			return;
		}

		if (req.method === "GET" && path === "/api/session/active") {
			this.json(res, 200, { sessionID: undefined });
			return;
		}

		if (req.method === "GET" && path === "/api/model") {
			this.json(res, 200, []);
			return;
		}

		if (req.method === "GET" && path === "/api/experimental/migration/v1") {
			// pi sessions have no V1 history to migrate.
			this.json(res, 200, { status: "completed" });
			return;
		}

		if (req.method === "GET" && path === "/api/fs/list") {
			const directory = url.searchParams.get("location[directory]") ?? process.cwd();
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
			const directory = url.searchParams.get("location[directory]") ?? process.cwd();
			this.json(res, 200, { location: { directory, worktree: directory }, data: [] });
			return;
		}

		if (req.method === "GET" && path === "/api/project") {
			this.json(res, 200, []);
			return;
		}

		// Generic stub: every opencode list endpoint shares the location envelope.
		if (req.method === "GET" && path.startsWith("/api/")) {
			const directory = url.searchParams.get("location[directory]") ?? process.cwd();
			this.log(`STUB ${req.method} ${path}`);
			this.json(res, 200, { location: { directory, worktree: directory }, data: [] });
			return;
		}

		// Not implemented yet: log the request so the gap list is enumerable.
		this.log(`MISSING ${req.method} ${path}`);
		this.json(res, 404, { error: "not-implemented", path });
	}
}
