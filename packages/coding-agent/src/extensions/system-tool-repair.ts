import type { ExtensionAPI } from "../core/extensions/types.ts";

/**
 * Re-activate always-expected system tools that the transcript froze out.
 *
 * Continuing an old session restores the tool loadout the transcript records; a
 * transcript written while a tool was missing (a host without this extension,
 * or a poisoned loadout) keeps the tool inactive in every later process. Call
 * this from `before_agent_start`: activating is idempotent, and tools this host
 * does not register or cannot declare (extension disabled, hidden exposure) are
 * dropped by the loadout, so the visible repair note only fires when a missing
 * tool actually came back — never per turn for a deliberately absent one.
 */
export function ensureSystemToolsActive(pi: ExtensionAPI, toolNames: readonly string[]): void {
	// A captured pi goes stale after an in-process reload; the rebuilt runtime
	// re-activates every registered tool on its own there, so a stale throw is skippable.
	try {
		if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
		const active = pi.getActiveTools();
		const missing = toolNames.filter((name) => !active.includes(name));
		if (missing.length === 0) return;
		pi.setActiveTools([...active, ...missing]);
		// Only names the loadout accepted were actually frozen out; the rest
		// (unregistered, hidden) stay absent without any repair noise.
		const rescued = pi.getActiveTools().filter((name) => missing.includes(name));
		if (rescued.length === 0 || typeof pi.sendMessage !== "function") return;
		pi.sendMessage({
			customType: "toolset-update",
			display: false,
			content: `工具集已恢复：${rescued.map((name) => `+${name}`).join("、")}（该会话历史冻结的工具集缺少${rescued.length === 1 ? "它" : "它们"}，本轮起可用）。`,
			details: { added: rescued },
		});
	} catch {
		// Stale extension ctx after reload — activation already happened.
	}
}
