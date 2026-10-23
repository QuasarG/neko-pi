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
	/** Which context block this file feeds ("system/persona", "memory", "continuity"). */
	target?: string;
	/** How the file reaches the model: full text, catalog entry, or state summary. */
	injection?: "full" | "catalog" | "state";
	/** What changing this file does to the running context. */
	changeEffect?: string;
	/**
	 * Session-scoped: this file's content changed after the requesting
	 * session's last memory delivery receipt, so its next message will carry
	 * a fresh injection. Only set when the query names a session.
	 */
	pending?: boolean;
}

/** How each file kind reaches the model. */
const KIND_INJECTION: Record<PersonaFile["kind"], PersonaFile["injection"]> = {
	identity: "full",
	voice: "full",
	manifest: "state",
	memory: "full",
	continuity: "state",
};

const KIND_TARGET: Record<PersonaFile["kind"], string> = {
	identity: "系统提示 · 身份",
	voice: "系统提示 · 语气",
	manifest: "人设元信息",
	memory: "记忆注入",
	continuity: "连续状态注入",
};

const KIND_EFFECT: Record<PersonaFile["kind"], string> = {
	identity: "下一消息重载身份",
	voice: "下一消息重载语气",
	manifest: "元信息随人设读取",
	memory: "变更后下一条消息全量重注入",
	continuity: "内容变化时随记忆重注入",
};

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
			target: KIND_TARGET[kind],
			injection: KIND_INJECTION[kind],
			changeEffect: KIND_EFFECT[kind],
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
