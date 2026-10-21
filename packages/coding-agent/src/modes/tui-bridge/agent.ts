import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { atomicWrite, readState } from "../../core/storage.ts";
import { builtInExtensions } from "../../extensions/index.ts";
import type { BridgeAgent, BridgeModel } from "./server.ts";

export async function createBridgeAgent(
	cwd: string,
	selection?: BridgeModel,
	sessionID?: string,
): Promise<BridgeAgent> {
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
	const model = selection ? modelRuntime.getModel(selection.providerID, selection.id) : undefined;
	if (selection && !model) throw new Error(`Model not found: ${selection.providerID}/${selection.id}`);
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
	if (pointer) atomicWrite(pointer, JSON.stringify(sessionManager.getSessionFile()));
	return {
		prompt: (text, options) => session.prompt(text, options),
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
