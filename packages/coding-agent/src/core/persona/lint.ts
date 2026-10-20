/**
 * Persona output lint framework.
 *
 * The harness provides the mechanism only: rule data lives in a persona pack
 * (`lint/rules.json`). The default engine evaluates assistant text against
 * configurable rules and reports violations; enforcement policy (rewrite,
 * reject, log-only) is chosen by the pack and applied by the caller.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A single lint rule, fully data-driven. */
export interface PersonaLintRule {
	/** Stable rule id, e.g. "assistant-tone". */
	id: string;
	/** Human-readable description used in diagnostics. */
	description: string;
	/** Rule kind; selects the matcher. */
	kind: "blacklist-pattern" | "max-plain-technical-lines";
	/** For blacklist-pattern: source strings of case-insensitive regexes. */
	patterns?: string[];
	/** For max-plain-technical-lines: allowed consecutive plain lines. */
	maxLines?: number;
	/** Severity, informational for now; enforcement policy arrives with M2. */
	severity: "info" | "warn" | "error";
}

/** Parsed lint/rules.json of a persona pack. */
export interface PersonaLintConfig {
	rules: PersonaLintRule[];
}

/** One violation found in a piece of assistant output. */
export interface PersonaLintViolation {
	ruleId: string;
	description: string;
	severity: PersonaLintRule["severity"];
	/** Line number (1-based) where the violation was detected, when applicable. */
	line?: number;
	/** Short excerpt of the offending text. */
	excerpt: string;
}

/** Heuristic: a line without persona flavor — no second-person address, no punctuation pauses. */
const PLAIN_TECHNICAL_LINE = /^[A-Za-z0-9`_\-#*.,:;()[\]{}<>/\\="'%+\s]+$/;

/** Load lint rules from a persona pack root; empty config when absent. */
export function loadLintConfig(packRoot: string): PersonaLintConfig {
	const rulesPath = join(packRoot, "lint", "rules.json");
	if (!existsSync(rulesPath)) return { rules: [] };
	try {
		const parsed = JSON.parse(readFileSync(rulesPath, "utf-8")) as Partial<PersonaLintConfig>;
		const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
		return { rules: rules.filter((rule) => rule && typeof rule.id === "string") };
	} catch {
		// A malformed rules file must never take down the session; run with no rules.
		return { rules: [] };
	}
}

/** Evaluate assistant text against a lint config. Pure; no I/O. */
export function checkPersonaLint(text: string, config: PersonaLintConfig): PersonaLintViolation[] {
	const violations: PersonaLintViolation[] = [];
	const lines = text.split("\n");

	for (const rule of config.rules) {
		if (rule.kind === "blacklist-pattern") {
			for (const source of rule.patterns ?? []) {
				let regex: RegExp;
				try {
					regex = new RegExp(source, "i");
				} catch {
					continue; // Invalid user-provided pattern: skip, never crash.
				}
				for (let i = 0; i < lines.length; i++) {
					if (regex.test(lines[i])) {
						violations.push({
							ruleId: rule.id,
							description: rule.description,
							severity: rule.severity,
							line: i + 1,
							excerpt: lines[i].slice(0, 80),
						});
						break; // One hit per pattern is enough for a diagnostic.
					}
				}
			}
		} else if (rule.kind === "max-plain-technical-lines") {
			const max = rule.maxLines ?? 2;
			let run = 0;
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i].trim();
				if (line.length > 0 && PLAIN_TECHNICAL_LINE.test(line)) {
					run++;
					if (run > max) {
						violations.push({
							ruleId: rule.id,
							description: rule.description,
							severity: rule.severity,
							line: i + 1,
							excerpt: line.slice(0, 80),
						});
						run = 0; // Report once per run.
					}
				} else {
					run = 0;
				}
			}
		}
	}

	return violations;
}
