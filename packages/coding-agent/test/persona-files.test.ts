import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getPersonaFiles, type PersonaFile } from "../src/modes/tui-bridge/persona-files.ts";
import { TuiBridge } from "../src/modes/tui-bridge/server.ts";

it("reports only neko-pi runtime files without exposing document contents or changing sources", async () => {
	const root = mkdtempSync(join(tmpdir(), "neko-files-"));
	try {
		const personaRoot = join(root, "persona");
		const memoryRoot = join(root, "memory");
		const references = join(root, "source documents");
		mkdirSync(join(personaRoot, "voice"), { recursive: true });
		mkdirSync(memoryRoot);
		mkdirSync(references);
		writeFileSync(join(root, "AGENTS.md"), "Private context sentinel");
		writeFileSync(join(references, "memory.md"), "Private source sentinel");
		const identity = `Private identity sentinel. Do not track [external source](<${join(references, "memory.md")}>) or \`~/.neko_mem/master.md\`.`;
		writeFileSync(join(personaRoot, "persona.md"), identity);
		writeFileSync(join(personaRoot, "voice", "style.md"), "Private voice sentinel");
		writeFileSync(
			join(memoryRoot, "record.md"),
			"---\ntype: profile\ntitle: Preference\n---\nPrivate runtime sentinel",
		);
		const options = { personaRoot, memoryRoot };
		const files = getPersonaFiles(options);
		expect(files).toContainEqual(
			expect.objectContaining({ path: join(personaRoot, "persona.md"), kind: "identity", available: true }),
		);
		expect(files.some((file) => file.path === join(root, "AGENTS.md"))).toBe(false);
		expect(files.some((file) => file.path === join(references, "memory.md"))).toBe(false);
		expect(files.some((file) => file.path.includes(".neko_mem"))).toBe(false);
		expect(JSON.stringify(files)).not.toContain("sentinel");
		expect(readFileSync(join(personaRoot, "persona.md"), "utf8")).toBe(identity);
		const bridge = new TuiBridge({ personaFiles: () => getPersonaFiles(options), onLog: () => {} });
		const port = await bridge.listen();
		try {
			expect(await (await fetch(`http://127.0.0.1:${port}/api/neko/files`)).json()).toEqual({ files });
			unlinkSync(join(references, "memory.md"));
			const response = (await (await fetch(`http://127.0.0.1:${port}/api/neko/files`)).json()) as {
				files: PersonaFile[];
			};
			expect(response.files).toEqual(files);
		} finally {
			await bridge.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
