/**
 * Built-in persona lint extension.
 *
 * Evaluates each completed assistant message against the persona pack's
 * lint/rules.json (via the persona lint engine) and surfaces violations as
 * a UI notification. Enforcement policy (rewrite/reject) arrives with M2;
 * M1-4 is observation-only so the pipeline stays non-blocking.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "../../index.ts";
import { checkPersonaLint, type PersonaLintConfig } from "../persona/lint.ts";
import { loadPersonaPack } from "../persona/loader.ts";

function readRulesFile(packRoot: string): PersonaLintConfig {
	const rulesPath = join(packRoot, "lint", "rules.json");
	if (!existsSync(rulesPath)) return { rules: [] };
	try {
		const parsed = JSON.parse(readFileSync(rulesPath, "utf-8")) as Partial<PersonaLintConfig>;
		const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
		return { rules: rules.filter((rule) => rule && typeof rule.id === "string") };
	} catch {
		return { rules: [] };
	}
}

function lastAssistantText(ctx: { session?: { messages?: Array<{ role?: string; content?: unknown }> } }): string | null {
	const messages = ctx.session?.messages;
	if (!Array.isArray(messages)) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		const c = m.content;
		if (typeof c === "string") return c;
		if (Array.isArray(c)) {
			return c
				.map((part) =>
					part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "",
				)
				.join("\n");
		}
		return null;
	}
	return null;
}

export default function personaLintExtension(pi: ExtensionAPI): void {
	const pack = loadPersonaPack();
	if (!pack) return;

	const config = readRulesFile(pack.root);
	if (!config.rules || config.rules.length === 0) return;

	pi.registerCommand("persona-lint", {
		description: "Re-run persona lint rules on the last assistant message",
		handler: async (_args, ctx) => {
			const last = lastAssistantText(ctx);
			if (!last) {
				ctx.ui.notify("persona-lint: no assistant message to check yet.", "info");
				return;
			}
			const violations = checkPersonaLint(last, config);
			if (violations.length === 0) {
				ctx.ui.notify("persona-lint: clean", "info");
				return;
			}
			const lines = violations
				.slice(0, 5)
				.map((v) => `[${v.ruleId}] line ${v.line ?? "?"}: ${v.excerpt}`)
				.join("\n");
			ctx.ui.notify(`persona-lint: ${violations.length} violation(s)\n${lines}`, "warn");
		},
	});
}
