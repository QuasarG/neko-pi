import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { loadPersonaPack, personaPackDir } from "./persona/loader.ts";
import { atomicWrite, readState, withStorageLock } from "./storage.ts";

export interface InitDraft {
	step: number;
	name: string;
	identity: string;
	voice: string;
	timeZone: string;
}

export function getInitDraft(): InitDraft {
	const pack = loadPersonaPack();
	const saved = readState(join(getAgentDir(), "init-draft.json"));
	const defaults: InitDraft = {
		step: 0,
		name: pack?.name ?? "",
		identity: pack?.identity ?? "",
		voice: pack?.voice ?? "",
		timeZone: runtimeTimeZone(),
	};
	return saved === undefined ? defaults : validateDraft(saved);
}

function validateDraft(value: unknown): InitDraft {
	if (!value || typeof value !== "object") throw new Error("Invalid configuration draft");
	const draft = value as Partial<InitDraft>;
	for (const key of ["name", "identity", "voice", "timeZone"] as const) {
		if (
			typeof draft[key] !== "string" ||
			Buffer.byteLength(draft[key]) > (key === "identity" || key === "voice" ? 64000 : 200)
		)
			throw new Error(`Invalid ${key}`);
	}
	if (!Number.isInteger(draft.step) || draft.step! < 0 || draft.step! > 4) throw new Error("Invalid setup step");
	new Intl.DateTimeFormat("en", { timeZone: draft.timeZone });
	return draft as InitDraft;
}

export function saveInitDraft(value: unknown): InitDraft {
	const draft = validateDraft(value);
	if (draft.step >= 1 && !draft.name.trim()) throw new Error("请填写称呼后继续");
	if (draft.step >= 2 && !draft.identity.trim()) throw new Error("请填写身份后继续");
	atomicWrite(join(getAgentDir(), "init-draft.json"), JSON.stringify(draft));
	return draft;
}

export function finishInit(value: unknown): void {
	const draft = validateDraft(value);
	if (!draft.name.trim() || !draft.identity.trim()) throw new Error("Name and identity are required");
	withStorageLock(join(getAgentDir(), "init"), () => {
		const root = personaPackDir();
		const manifestPath = join(root, "manifest.json");
		const previous = readState(manifestPath);
		atomicWrite(join(root, "persona.md"), draft.identity.trim());
		atomicWrite(join(root, "voice", "style.md"), draft.voice.trim());
		atomicWrite(
			manifestPath,
			JSON.stringify(
				{ ...(previous && typeof previous === "object" ? previous : {}), name: draft.name.trim() },
				null,
				2,
			),
		);
		atomicWrite(join(getAgentDir(), "runtime.json"), JSON.stringify({ timeZone: draft.timeZone }));
		atomicWrite(join(getAgentDir(), "init-draft.json"), JSON.stringify({ ...draft, step: 0 }));
	});
}

export function runtimeTimeZone(): string {
	const value = readState(join(getAgentDir(), "runtime.json"));
	if (value && typeof value === "object" && "timeZone" in value && typeof value.timeZone === "string") {
		new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
		return value.timeZone;
	}
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
