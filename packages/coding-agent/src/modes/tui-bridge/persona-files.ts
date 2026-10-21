import { existsSync, realpathSync, type Stats, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { defaultMemoryDir, MemoryStore } from "../../core/memory/store.ts";
import { loadPersonaPack, personaPackDir } from "../../core/persona/loader.ts";

export interface PersonaFile {
	path: string;
	name: string;
	kind: "identity" | "voice" | "manifest" | "memory" | "continuity";
	available: boolean;
	directory: boolean;
	modifiedAt?: number;
}

export function getPersonaFiles(options: { personaRoot?: string; memoryRoot?: string }): PersonaFile[] {
	const root = options.personaRoot ?? personaPackDir();
	const memoryRoot = options.memoryRoot ?? defaultMemoryDir();
	const files = new Map<string, PersonaFile>();
	const add = (path: string, kind: PersonaFile["kind"]) => {
		path = resolve(path);
		let info: Stats | undefined;
		try {
			info = statSync(path);
		} catch (error) {
			if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
		const key = info ? realpathSync(path) : path;
		if (files.has(key)) return;
		files.set(key, {
			path,
			name: basename(path),
			kind,
			available: Boolean(info?.isFile() || info?.isDirectory()),
			directory: info?.isDirectory() ?? false,
			...(info ? { modifiedAt: info.mtimeMs } : {}),
		});
	};
	const pack = loadPersonaPack(root);
	if (pack) {
		const identity = join(root, "persona.md");
		add(identity, "identity");
		if (pack.voice) {
			const voice = join(root, "voice", "style.md");
			add(voice, "voice");
		}
		if (existsSync(join(root, "manifest.json"))) add(join(root, "manifest.json"), "manifest");
	}
	for (const record of new MemoryStore(memoryRoot).list(true)) {
		if (record.file) add(join(memoryRoot, record.file), "memory");
	}
	if (existsSync(join(memoryRoot, "continuity.json"))) add(join(memoryRoot, "continuity.json"), "continuity");
	return [...files.values()];
}
