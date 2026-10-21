import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getPersonaStatus } from "../src/modes/tui-bridge/persona.ts";

it("reports resource availability without private persona or memory content", () => {
	const root = mkdtempSync(join(tmpdir(), "neko-status-"));
	try {
		const personaRoot = join(root, "persona");
		const memoryRoot = join(root, "memory");
		expect(getPersonaStatus({ personaRoot, memoryRoot })).toEqual({
			name: "Neko",
			identityReady: false,
			voiceReady: false,
			memoryFiles: 0,
			lintConfigured: false,
		});
		mkdirSync(join(personaRoot, "voice"), { recursive: true });
		mkdirSync(join(personaRoot, "lint"));
		mkdirSync(memoryRoot);
		writeFileSync(join(personaRoot, "persona.md"), "private identity sentinel");
		writeFileSync(join(personaRoot, "voice", "style.md"), "private voice sentinel");
		writeFileSync(join(personaRoot, "manifest.json"), JSON.stringify({ name: "Resident" }));
		writeFileSync(join(personaRoot, "lint", "rules.json"), "{}");
		writeFileSync(join(memoryRoot, "memory.md"), "---\ntype: profile\ntitle: test\n---\nprivate memory sentinel");
		const status = getPersonaStatus({ personaRoot, memoryRoot });
		expect(status).toEqual({
			name: "Resident",
			identityReady: true,
			voiceReady: true,
			memoryFiles: 1,
			lintConfigured: true,
		});
		expect(JSON.stringify(status)).not.toContain("sentinel");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
