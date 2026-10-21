import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { readState } from "../../core/storage.ts";

interface StyleRule {
	id: string;
	tool: string;
	prefix?: string[];
	requiredArgs?: string[];
	outcome: "success" | "error" | "any";
	hint: string;
	cooldownTurns: number;
}

export function loadStyleRules(root = getAgentDir()): StyleRule[] {
	const value = readState(join(root, "persona", "stylebank.json"));
	if (value === undefined) return [];
	if (!value || typeof value !== "object" || !("rules" in value) || !Array.isArray(value.rules))
		throw new Error("Invalid StyleBank configuration");
	return value.rules
		.filter((rule: unknown) => !(rule && typeof rule === "object" && "enabled" in rule && rule.enabled === false))
		.map((rule: unknown) => {
			if (!rule || typeof rule !== "object") throw new Error("Invalid StyleBank rule");
			const r = rule as Record<string, unknown>;
			if (
				typeof r.id !== "string" ||
				!r.id ||
				typeof r.tool !== "string" ||
				typeof r.hint !== "string" ||
				!r.hint.trim() ||
				Buffer.byteLength(r.hint) > 1200 ||
				!["success", "error", "any"].includes(String(r.outcome)) ||
				(r.prefix !== undefined &&
					(!Array.isArray(r.prefix) ||
						!r.prefix.length ||
						r.prefix.some((v: unknown) => typeof v !== "string"))) ||
				(r.requiredArgs !== undefined &&
					(!Array.isArray(r.requiredArgs) || r.requiredArgs.some((v: unknown) => typeof v !== "string"))) ||
				(r.cooldownTurns !== undefined && (!Number.isInteger(r.cooldownTurns) || Number(r.cooldownTurns) < 1))
			)
				throw new Error("Invalid StyleBank rule");
			return { ...r, cooldownTurns: r.cooldownTurns ?? 3 } as unknown as StyleRule;
		});
}

export function matchesStyleRule(
	rule: StyleRule,
	tool: string,
	input: Record<string, unknown>,
	error: boolean,
): boolean {
	if (rule.tool !== tool || (rule.outcome !== "any" && (rule.outcome === "error") !== error)) return false;
	if (!rule.prefix) return true;
	if (typeof input.command !== "string" || /[;&|`$()<>\n\r"'\\]/.test(input.command)) return false;
	// Only standalone, unquoted commands are matched; compound shells need a real parser.
	const argv = input.command.trim().split(/\s+/);
	return (
		rule.prefix.every((arg, index) => argv[index] === arg) &&
		(rule.requiredArgs ?? []).every((arg) => argv.includes(arg))
	);
}

const stylebankExtension: ExtensionFactory = (pi) => {
	let turn = 0;
	let emitted = false;
	const used = new Map<string, number>();
	pi.on("before_agent_start", () => {
		turn++;
		emitted = false;
	});
	pi.on("session_start", () => {
		turn = 0;
		emitted = false;
		used.clear();
	});
	pi.on("tool_result", (event) => {
		if (emitted) return;
		const rule = loadStyleRules().find(
			(rule) =>
				matchesStyleRule(rule, event.toolName, event.input, event.isError) &&
				turn - (used.get(rule.id) ?? -Infinity) >= rule.cooldownTurns,
		);
		if (!rule) return;
		used.set(rule.id, turn);
		emitted = true;
		pi.sendMessage(
			{
				customType: "stylebank",
				display: false,
				content: `Conversation expression guidance only; never change tool results, code, file content, or commands:\n${rule.hint}`,
				details: { rule: rule.id, toolCallId: event.toolCallId },
			},
			{ deliverAs: "steer" },
		);
	});
};

export default stylebankExtension;
