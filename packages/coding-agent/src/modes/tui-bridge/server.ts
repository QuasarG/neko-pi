/**
 * HTTP bridge that presents a subset of the opencode server protocol on top
 * of pi's agent core, so the vendored opencode TUI can run unmodified.
 *
 * Phase 1 (this file): request logging + SSE event stream + stubbed boot
 * endpoints. Every unknown route logs loudly and returns a structured 404 so
 * the TUI's needs can be enumerated by simply running it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

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
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(": bridge-open\n\n");
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

		if (req.method === "GET" && path === "/api/config") {
			this.json(res, 200, { config: {} });
			return;
		}

		if (req.method === "GET" && path === "/api/location") {
			this.json(res, 200, { location: { directory: process.cwd(), worktree: process.cwd(), vcs: "git" } });
			return;
		}

		if (req.method === "GET" && path === "/api/session") {
			this.json(res, 200, []);
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

		if (req.method === "GET" && path === "/api/project") {
			this.json(res, 200, []);
			return;
		}

		// Not implemented yet: log the request so the gap list is enumerable.
		this.log(`MISSING ${req.method} ${path}`);
		this.json(res, 404, { error: "not-implemented", path });
	}
}
