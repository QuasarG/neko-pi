/**
 * `neko-pi ui` — boot the vendored opencode TUI against the local bridge.
 *
 * Starts the bridge server on a random loopback port, spawns the TUI under
 * bun with PI_BRIDGE_URL pointing at it, and tears everything down when the
 * TUI exits.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TuiBridge } from "./server.ts";

function findBun(): string | undefined {
	const candidates = [join(process.env.HOME ?? "", ".bun", "bin", "bun"), "/usr/local/bin/bun", "/usr/bin/bun"];
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return undefined;
}

function findTuiRoot(): string | undefined {
	const fromEnv = process.env.NEKO_PI_TUI_ROOT;
	if (fromEnv && existsSync(join(fromEnv, "src", "pi-main.tsx"))) return fromEnv;
	const candidates = [
		join(process.cwd(), "vendor", "opencode", "tui"),
		join(import.meta.dirname ?? "", "..", "..", "..", "..", "..", "vendor", "opencode", "tui"),
	];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "src", "pi-main.tsx"))) return candidate;
	}
	return undefined;
}

export async function runTuiBridge(args: string[]): Promise<void> {
	const bun = findBun();
	if (!bun) {
		console.error(
			"bun not found — install it to ~/.bun/bin/bun (see docs/superpowers/specs/2026-10-20-opencode-tui-port.md)",
		);
		process.exitCode = 1;
		return;
	}
	const tuiRoot = findTuiRoot();
	if (!tuiRoot) {
		console.error("vendored TUI not found — expected vendor/opencode/tui/src/pi-main.tsx");
		process.exitCode = 1;
		return;
	}

	const bridge = new TuiBridge();
	const port = await bridge.listen();
	const url = `http://127.0.0.1:${port}`;
	console.error(`[bridge] listening on ${url}`);

	const sessionID = args.find((arg) => !arg.startsWith("-"));
	// Isolate the TUI's global config from any installed opencode so vendored
	// schema never collides with the user's real opencode settings.
	const configDir = join(process.env.HOME ?? "", ".pi", "tui");
	mkdirSync(configDir, { recursive: true });
	const child = spawn(bun, ["src/pi-main.tsx", ...(sessionID ? [sessionID] : [])], {
		cwd: tuiRoot,
		env: { ...process.env, PI_BRIDGE_URL: url, OPENCODE_CONFIG_DIR: configDir },
		stdio: "inherit",
	});

	const shutdown = (code: number): void => {
		void bridge.close().finally(() => process.exit(code));
	};
	child.on("exit", (code) => shutdown(code ?? 0));
	process.on("SIGINT", () => {
		child.kill("SIGINT");
	});
	process.on("SIGTERM", () => {
		child.kill("SIGTERM");
	});
}
