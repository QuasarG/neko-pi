import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadStyleRules, matchesStyleRule } from "../src/extensions/stylebank/index.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rulesRoot(rules: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "neko-stylebank-"));
	scratch.push(root);
	mkdirSync(join(root, "persona"), { recursive: true });
	writeFileSync(join(root, "persona", "stylebank.json"), JSON.stringify({ rules }));
	return root;
}

describe("stylebank", () => {
	test("matches only the configured tool, prefix and outcome", () => {
		const root = rulesRoot([
			{ id: "r1", tool: "bash", prefix: ["git", "push"], outcome: "success", hint: "celebratory" },
		]);
		const [rule] = loadStyleRules(root);
		expect(matchesStyleRule(rule!, "bash", { command: "git push origin main" }, false)).toBe(true);
		expect(matchesStyleRule(rule!, "bash", { command: "git push origin main" }, true)).toBe(false);
		expect(matchesStyleRule(rule!, "bash", { command: "git status" }, false)).toBe(false);
		expect(matchesStyleRule(rule!, "grep", { command: "git push" }, false)).toBe(false);
	});

	test("compound shell, quoted text and missing command never match", () => {
		const root = rulesRoot([{ id: "r2", tool: "bash", prefix: ["npm"], outcome: "any", hint: "pace yourself" }]);
		const [rule] = loadStyleRules(root);
		expect(matchesStyleRule(rule!, "bash", { command: "npm test && npm run check" }, false)).toBe(false);
		expect(matchesStyleRule(rule!, "bash", { command: 'echo "npm install"' }, false)).toBe(false);
		expect(matchesStyleRule(rule!, "bash", { command: "npm $(whoami)" }, false)).toBe(false);
		expect(matchesStyleRule(rule!, "bash", {}, false)).toBe(false);
		expect(matchesStyleRule(rule!, "bash", { command: "npm install" }, false)).toBe(true);
	});

	test("empty or disabled rule sets load to nothing", () => {
		const empty = mkdtempSync(join(tmpdir(), "neko-stylebank-"));
		scratch.push(empty);
		expect(loadStyleRules(empty)).toEqual([]);
		const disabled = rulesRoot([
			{ id: "r3", tool: "bash", outcome: "any", hint: "off", enabled: false, prefix: ["ls"] },
		]);
		expect(loadStyleRules(disabled)).toEqual([]);
	});
});
