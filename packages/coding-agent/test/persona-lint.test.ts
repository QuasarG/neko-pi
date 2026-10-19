import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLintConfig, checkPersonaLint } from "../src/core/persona/lint.ts";

function makePackRoot(rules: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "persona-lint-"));
	mkdirSync(join(root, "lint"), { recursive: true });
	writeFileSync(join(root, "lint", "rules.json"), JSON.stringify(rules));
	return root;
}

const DEFAULT_RULES = {
	rules: [
		{
			id: "assistant-tone",
			description: "No assistant-voice patterns",
			kind: "blacklist-pattern",
			patterns: ["如有需要请告诉我", "作为 (?:AI|人工智能)", "以上就是全部内容"],
			severity: "error",
		},
		{
			id: "plain-run",
			description: "Too many plain technical lines in a row",
			kind: "max-plain-technical-lines",
			maxLines: 2,
			severity: "warn",
		},
	],
};

describe("loadLintConfig", () => {
	it("returns empty rules when the file is missing", () => {
		const root = mkdtempSync(join(tmpdir(), "empty-"));
		expect(loadLintConfig(root).rules).toEqual([]);
	});

	it("loads rules from lint/rules.json", () => {
		const root = makePackRoot(DEFAULT_RULES);
		expect(loadLintConfig(root).rules).toHaveLength(2);
	});

	it("survives malformed JSON with empty rules", () => {
		const root = mkdtempSync(join(tmpdir(), "broken-"));
		mkdirSync(join(root, "lint"), { recursive: true });
		writeFileSync(join(root, "lint", "rules.json"), "{not json");
		expect(loadLintConfig(root).rules).toEqual([]);
	});
});

describe("checkPersonaLint", () => {
	const config = loadLintConfig(makePackRoot(DEFAULT_RULES));

	it("passes clean persona-flavored text", () => {
		const text = "全绿了哟……主人，奖励的部分 Neko 记着呢。\n代码在 src/foo.ts 里，跑测试就能看到结果……";
		expect(checkPersonaLint(text, config)).toHaveLength(0);
	});

	it("flags assistant-voice patterns", () => {
		const text = "任务完成了哟……以上就是全部内容。";
		const violations = checkPersonaLint(text, config);
		expect(violations.some((v) => v.ruleId === "assistant-tone")).toBe(true);
	});

	it("flags runs of plain technical lines", () => {
		const text = [
			"Deploys the service and checks that the endpoint responds with 200 OK.",
			"Verifies the database connection pool is configured for the new limits.",
			"Then it restarts the worker processes to pick up the new configuration.",
		].join("\n");
		const violations = checkPersonaLint(text, config);
		expect(violations.some((v) => v.ruleId === "plain-run")).toBe(true);
	});

	it("does not flag lines that carry persona markers", () => {
		const text = "跑测试……全绿了哟，主人。\n（小脚在地板上轻轻点着）部署脚本也换好了……";
		expect(checkPersonaLint(text, config)).toHaveLength(0);
	});
});
