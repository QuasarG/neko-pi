import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersonaPack, personaPackDir } from "../src/core/persona/loader.ts";
import { buildSystemPromptSections } from "../src/core/system-prompt.ts";

function makePack(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "persona-pack-"));
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

describe("loadPersonaPack", () => {
	it("returns null when persona.md is missing", () => {
		const root = makePack({ "voice/style.md": "style" });
		expect(loadPersonaPack(root)).toBeNull();
	});

	it("returns null when persona.md is empty", () => {
		const root = makePack({ "persona.md": "   " });
		expect(loadPersonaPack(root)).toBeNull();
	});

	it("loads identity and optional voice", () => {
		const root = makePack({
			"persona.md": "# Butler\nSpeak politely.",
			"voice/style.md": "Examples: ...",
		});
		const pack = loadPersonaPack(root);
		expect(pack?.identity).toContain("Butler");
		expect(pack?.voice).toContain("Examples");
		expect(pack?.name).toBeTruthy();
	});

	it("pack without voice loads identity only", () => {
		const root = makePack({ "persona.md": "identity" });
		const pack = loadPersonaPack(root);
		expect(pack?.voice).toBeUndefined();
	});

	it("default directory is under ~/.pi/agent/persona", () => {
		expect(personaPackDir()).toContain(join(".pi", "agent", "persona"));
	});
});

describe("buildSystemPromptSections with persona", () => {
	it("persona identity replaces the default preamble and voice gets its own section", () => {
		const sections = buildSystemPromptSections({
			cwd: "/tmp",
			persona: { identity: "IDENTITY-CORE", voice: "VOICE-BLOCK" },
		});
		expect(sections.preamble).toBe("IDENTITY-CORE");
		expect(sections["<persona_voice>"]).toBeUndefined();
		expect(sections.persona_voice).toContain("VOICE-BLOCK");
		// Tools section survives so the model still knows its toolset.
		expect(sections.tools).toBeTruthy();
		// Rules/docs are persona-owned when a persona is present.
		expect(sections.rules).toBeUndefined();
	});

	it("custom prompt still wins when no persona is set", () => {
		const sections = buildSystemPromptSections({
			cwd: "/tmp",
			customPrompt: "CUSTOM-PROMPT",
		});
		expect(sections.preamble).toBe("CUSTOM-PROMPT");
		expect(sections.rules).toBeTruthy();
	});

	it("default preamble mentions neko-pi, not bare pi branding", () => {
		const sections = buildSystemPromptSections({ cwd: "/tmp" });
		expect(sections.preamble).toContain("neko-pi");
		expect(sections.preamble).not.toContain("inside pi,");
	});
});

describe("pack cleanup", () => {
	it("removes temp roots", () => {
		const root = makePack({ "persona.md": "x" });
		expect(loadPersonaPack(root)).not.toBeNull();
		rmSync(root, { recursive: true, force: true });
	});
});
