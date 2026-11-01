import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { getCliEntryPath } from "../src/config.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("an SDK host launches this package's CLI instead of its Next.js entry", () => {
	const root = mkdtempSync(join(tmpdir(), "neko-cli-entry-"));
	roots.push(root);
	vi.stubEnv("PI_PACKAGE_DIR", root);
	const nextEntry = join(root, "next.js");
	writeFileSync(nextEntry, "");
	expect(getCliEntryPath(nextEntry)).toBe(join(root, "dist", "cli.js"));
	expect(getCliEntryPath(join(root, "missing.js"))).toBe(join(root, "dist", "cli.js"));
});

test("native source and bundled CLI launches retain the exact running entry", () => {
	const root = mkdtempSync(join(tmpdir(), "neko-cli-entry-"));
	roots.push(root);
	vi.stubEnv("PI_PACKAGE_DIR", root);
	for (const relative of ["src/cli.ts", "dist/cli.js", "dist/bundle/cli.js"]) {
		const entry = join(root, relative);
		mkdirSync(join(entry, ".."), { recursive: true });
		writeFileSync(entry, "");
		expect(getCliEntryPath(entry)).toBe(entry);
	}
});
