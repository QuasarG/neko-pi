import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

	it("skips the installed pack for subagent processes", () => {
		const root = makePack({ "persona.md": "identity", "voice/style.md": "style" });
		process.env.NEKO_PI_NO_PERSONA = "1";
		try {
			expect(loadPersonaPack(root)).toBeNull();
		} finally {
			delete process.env.NEKO_PI_NO_PERSONA;
		}
		// The flag is scoped to the child process; the parent's pack still loads.
		expect(loadPersonaPack(root)?.identity).toBe("identity");
	});

	it("default directory is under ~/.neko_pi/persona", () => {
		expect(personaPackDir()).toContain(join(".neko_pi", "persona"));
	});
});

describe("buildSystemPromptSections with persona", () => {
	it("persona opens the harness sentence by name and keeps rules and docs", () => {
		const sections = buildSystemPromptSections({
			cwd: "/tmp",
			persona: { name: "Butler", identity: "IDENTITY-CORE", voice: "VOICE-BLOCK" },
		});
		// The harness sentence states the working environment (terminal, tools,
		// reading/executing/editing) under the persona's name; the identity text
		// follows it instead of replacing the layer entirely.
		expect(sections.preamble).toContain("You are Butler, an expert coding assistant operating inside neko-pi");
		expect(sections.preamble).toContain(
			"You help users by reading files, executing commands, editing code, and writing new files.",
		);
		expect(sections.preamble?.indexOf("neko-pi")).toBeLessThan(sections.preamble!.indexOf("IDENTITY-CORE"));
		expect(sections["<persona_voice>"]).toBeUndefined();
		expect(sections.persona_voice).toContain("VOICE-BLOCK");
		// Tools, rules, and docs all survive alongside the persona.
		expect(sections.tools).toBeTruthy();
		expect(sections.rules).toBeTruthy();
		expect(sections.docs).toContain("neko-pi documentation");
	});

	it("a persona without a name falls back to the unnamed harness sentence", () => {
		const sections = buildSystemPromptSections({
			cwd: "/tmp",
			persona: { identity: "IDENTITY-CORE" },
		});
		expect(sections.preamble).toContain("You are an expert coding assistant operating inside neko-pi");
		expect(sections.preamble).toContain("IDENTITY-CORE");
		expect(sections.rules).toBeTruthy();
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
