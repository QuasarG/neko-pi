/**
 * Boots the vendored opencode TUI against the local bridge.
 *
 * This is the default interactive frontend for `neko-pi`: the bridge server
 * starts on a random loopback port, the TUI runs under bun with PI_BRIDGE_URL
 * pointing at it, and everything tears down when the TUI exits. Set
 * NEKO_PI_CLASSIC_TUI=1 to keep the built-in pi-tui instead; when bun or the
 * vendored tree is missing the launcher reports why and returns false so the
 * caller can fall back.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { getMemoryChannel } from "../../core/memory/channel.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { getRuntimeState } from "../../core/runtime/state-db.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { createBridgeAgent } from "./agent.ts";
import { getPersonaStatus } from "./persona.ts";
import type { ModelRuntimeLike } from "./server.ts";
import { TuiBridge } from "./server.ts";
import { RUNTIME_SETTING_DESCRIPTORS, RuntimeSettings } from "./settings.ts";

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
	const base = import.meta.dirname ?? process.cwd();
	const candidates = [
		join(process.cwd(), "vendor", "opencode", "tui"),
		// src/modes/tui-bridge → repo root
		join(base, "..", "..", "..", "..", "..", "vendor", "opencode", "tui"),
		// dist/bundle/modes/tui-bridge → repo root (one extra dist level)
		join(base, "..", "..", "..", "..", "..", "..", "vendor", "opencode", "tui"),
	];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "src", "pi-main.tsx"))) return candidate;
	}
	return undefined;
}

export function opencodeTuiAvailable(): boolean {
	return findBun() !== undefined && findTuiRoot() !== undefined;
}

/** Returns when the TUI exits; resolves false when it cannot start. */
export async function runOpencodeTui(args: string[]): Promise<boolean> {
	const bun = findBun();
	if (!bun) {
		console.error("neko-pi TUI needs bun at ~/.bun/bin/bun — falling back to the classic pi-tui");
		return false;
	}
	const tuiRoot = findTuiRoot();
	if (!tuiRoot) {
		console.error("neko-pi frontend not found (vendor/opencode/tui) — falling back to the classic pi-tui");
		return false;
	}

	const sessionID = args.find((arg) => !arg.startsWith("-"));
	// Isolate the TUI's global config from any installed opencode so vendored
	// schema never collides with the user's real opencode settings.
	const configDir = join(getAgentDir(), "tui");
	mkdirSync(configDir, { recursive: true });
	const logStream = isTruthyEnv(process.env.NEKO_PI_BRIDGE_DEBUG)
		? undefined
		: createWriteStream(join(configDir, "bridge.log"), { flags: "a" });

	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
	// Read the saved default model through pi's own settings path so the
	// bridge's default matches what the CLI would use.
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(cwd, agentDir);
	const runtimeSettings = new RuntimeSettings(settings);
	const defaultModelId = settings.getDefaultModel();
	const defaultProviderId = settings.getDefaultProvider();
	const bridge = new TuiBridge({
		defaultDirectory: cwd,
		stateDir: join(getAgentDir(), "sessions", "bridge"),
		state: getRuntimeState(),
		memoryChannel: getMemoryChannel(),
		modelRuntime: modelRuntime as unknown as ModelRuntimeLike,
		...(defaultModelId && defaultProviderId
			? { defaultModel: { providerID: defaultProviderId, id: defaultModelId } }
			: {}),
		createAgent: (cwd, selection, sessionID, agentOptions) =>
			createBridgeAgent(cwd, selection, sessionID, agentOptions),
		personaStatus: getPersonaStatus,
		// Runtime settings go through pi's own SettingsManager so they
		// persist and apply exactly like CLI-set values (B08).
		runtimeSettings: {
			read: () => runtimeSettings.read(),
			write: (patch) => runtimeSettings.write(patch).then((values) => ({ ...values })),
			descriptors: RUNTIME_SETTING_DESCRIPTORS as unknown as Array<Record<string, unknown>>,
		},
		// Provider login/logout against the real credential store (B01).
		auth: modelRuntime,
		mcpConfigPaths: [join(agentDir, "mcp.json"), join(cwd, CONFIG_DIR_NAME, "mcp.json")],
		// Default: log to a file so bridge traffic never bleeds into the TUI screen.
		onLog: isTruthyEnv(process.env.NEKO_PI_BRIDGE_DEBUG)
			? (line) => console.error(line)
			: (line) => {
					logStream?.write(`${line}\n`);
				},
	});
	const port = await bridge.listen();
	const url = `http://127.0.0.1:${port}`;
	logStream?.write(`--- ${new Date().toISOString()} listening on ${url}\n`);
	const child = spawn(bun, ["src/pi-main.tsx", ...(sessionID ? [sessionID] : [])], {
		cwd: tuiRoot,
		env: {
			...process.env,
			NEKO_PI_HOME: getAgentDir(),
			PI_BRIDGE_URL: url,
			PI_BRIDGE_CWD: process.cwd(),
			OPENCODE_CONFIG_DIR: configDir,
		},
		stdio: "inherit",
	});

	const exitCode = await new Promise<number>((resolve) => {
		child.on("exit", (code) => resolve(code ?? 0));
		const forward = (signal: NodeJS.Signals) => {
			child.kill(signal);
		};
		process.on("SIGINT", forward);
		process.on("SIGTERM", forward);
	});
	// Bounded teardown: a stalled close (or anything after the child exits)
	// must never keep a dead UI's launcher process alive.
	const teardown = bridge.close();
	const forced = setTimeout(() => {
		console.error("bridge close timed out; forcing exit");
		process.exit(exitCode);
	}, 10_000);
	await teardown;
	clearTimeout(forced);
	process.exit(exitCode);
}

function isTruthyEnv(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}
