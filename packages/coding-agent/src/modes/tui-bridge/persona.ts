import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultMemoryDir, MemoryStore } from "../../core/memory/store.ts";
import { loadPersonaPack, personaPackDir } from "../../core/persona/loader.ts";
import { readState } from "../../core/storage.ts";

export interface PersonaStatus {
	name: string;
	identityReady: boolean;
	voiceReady: boolean;
	memoryFiles: number;
	lintConfigured: boolean;
	avatarPath?: string;
	memoryReadAt?: string;
	memoryMaintenance?: string;
}

export function getPersonaStatus(options: { personaRoot?: string; memoryRoot?: string } = {}): PersonaStatus {
	const root = options.personaRoot ?? personaPackDir();
	const pack = loadPersonaPack(root);
	const memoryRoot = options.memoryRoot ?? defaultMemoryDir();
	const avatarPath = join(root, "theme", "avatar", "hd", "happy_night_desk.png");
	const runtime = readState(join(memoryRoot, "runtime.json"));
	const receipt = runtime && typeof runtime === "object" ? (runtime as Record<string, unknown>) : {};
	return {
		name: pack?.name ?? "Neko",
		identityReady: Boolean(pack),
		voiceReady: Boolean(pack?.voice),
		memoryFiles: new MemoryStore(memoryRoot).stats().totalRecords,
		lintConfigured: existsSync(join(root, "lint", "rules.json")),
		...(existsSync(avatarPath) ? { avatarPath } : {}),
		...(typeof receipt.readAt === "string" ? { memoryReadAt: receipt.readAt } : {}),
		...(typeof receipt.maintenance === "string" ? { memoryMaintenance: receipt.maintenance } : {}),
	};
}
