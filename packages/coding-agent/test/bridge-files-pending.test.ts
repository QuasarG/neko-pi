import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryChannel } from "../src/core/memory/channel.ts";
import { RuntimeState } from "../src/core/runtime/state-db.ts";
import { getPersonaFiles } from "../src/modes/tui-bridge/persona-files.ts";
import { type BridgeAgent, TuiBridge } from "../src/modes/tui-bridge/server.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * /api/neko/files?session=… annotates memory records with a per-session
 * `pending` flag: the file changed after THIS session's last memory_catalog
 * receipt. The session that already received the change clears its flag;
 * another session that has not keeps warning — the panel scenario where an
 * edit lands in one conversation while an older one still owes an injection.
 */
describe("persona files pending per session", () => {
	test("receipt-anchored pending differs across sessions and clears on delivery", async () => {
		const root = mkdtempSync(join(tmpdir(), "neko-files-pending-"));
		scratch.push(root);
		const packRoot = join(root, "pack");
		const recordsDir = join(root, "memory", "persona");
		mkdirSync(packRoot, { recursive: true });
		mkdirSync(recordsDir, { recursive: true });
		writeFileSync(join(packRoot, "persona.md"), "# identity");
		const recordPath = join(recordsDir, "procedure-ledger--test000001.md");
		writeFileSync(
			recordPath,
			[
				"---",
				"id: rec_test000001",
				"type: procedure",
				"title: ledger",
				"created: 2026-10-23T00:00:00.000Z",
				"updated: 2026-10-23T00:00:00.000Z",
				"---",
				"",
				"body v1",
				"",
			].join("\n"),
		);

		const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
		const memoryChannel = new MemoryChannel(join(root, "memory"), state);
		const doneAgent = (nativeId: string): Promise<BridgeAgent> =>
			Promise.resolve({
				async prompt() {},
				subscribe: () => () => {},
				async setModel() {},
				async abort() {},
				async waitForIdle() {},
				dispose() {},
				getSessionId: () => nativeId,
			} as BridgeAgent);
		const bridge = new TuiBridge({
			defaultDirectory: root,
			modelsPath: "/nonexistent.json",
			stateDir: join(root, "sessions"),
			state,
			memoryChannel,
			personaFiles: () => getPersonaFiles({ personaRoot: packRoot, memoryRoot: recordsDir }),
			onLog: () => {},
			createAgent: (_cwd, _selection, sessionID) => doneAgent(`native_${sessionID}`),
		});
		const port = await bridge.listen();
		const base = `http://127.0.0.1:${port}`;
		const memoryFile = async (session?: string) => {
			const response = await fetch(
				`${base}/api/neko/files${session ? `?session=${encodeURIComponent(session)}` : ""}`,
			);
			expect(response.status).toBe(200);
			const value = (await response.json()) as { files: Array<{ path: string; kind: string; pending?: boolean }> };
			return value.files.find((file) => file.path === recordPath)!;
		};
		const openSession = async (id: string) => {
			const created = await fetch(`${base}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id, location: { directory: root } }),
			});
			expect(created.status).toBe(200);
			// One prompt creates the backend so the session resolves to its
			// native id (receipts are keyed by that id).
			const prompted = await fetch(`${base}/api/session/${id}/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "hello" }),
			});
			expect(prompted.status).toBe(200);
		};

		try {
			await openSession("ses_a");
			await openSession("ses_b");
			// No session: plain listing, no pending annotation.
			expect((await memoryFile()).pending).toBeUndefined();
			// Neither session has delivered memory yet: both pend.
			expect((await memoryFile("ses_a")).pending).toBe(true);
			expect((await memoryFile("ses_b")).pending).toBe(true);

			// Session A delivers (receipt commits now, after the file's mtime).
			state.markReceipt("native_ses_a", "memory_catalog", 1, "persona");
			expect((await memoryFile("ses_a")).pending).toBe(false);
			// Session B never delivered: it still warns — the cross-session split.
			expect((await memoryFile("ses_b")).pending).toBe(true);

			// The record changes again (any writer): both sessions owe it.
			writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")}body v2\n`);
			expect((await memoryFile("ses_a")).pending).toBe(true);
			expect((await memoryFile("ses_b")).pending).toBe(true);

			// A's next message delivers the update: its flag clears by itself,
			// B's stays until B receives it too.
			state.markReceipt("native_ses_a", "memory_catalog", 2, "persona");
			expect((await memoryFile("ses_a")).pending).toBe(false);
			expect((await memoryFile("ses_b")).pending).toBe(true);

			// Pack files reload every message and never pend.
			const packList = (await memoryFile("ses_b")).kind;
			expect(packList).toBe("memory");
			const identity = await (async () => {
				const response = await fetch(`${base}/api/neko/files?session=ses_b`);
				const value = (await response.json()) as { files: Array<{ kind: string; pending?: boolean }> };
				return value.files.find((file) => file.kind === "identity");
			})();
			expect(identity?.pending).toBeUndefined();
		} finally {
			await bridge.close();
		}
	});
});
