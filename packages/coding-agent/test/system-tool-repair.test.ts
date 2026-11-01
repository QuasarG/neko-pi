import { describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { ensureSystemToolsActive } from "../src/extensions/system-tool-repair.ts";

/** A fake pi whose loadout keeps only names in `registered`, like the real one. */
function fakePi(options: { active: string[]; registered: string[] }) {
	const sent: CustomMessage[] = [];
	let active = [...options.active];
	const pi = {
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = names.filter((name) => options.registered.includes(name));
		},
		sendMessage: (message: Pick<CustomMessage, "customType" | "content" | "display" | "details">) => {
			sent.push(message as CustomMessage);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, sent };
}

const markerText = (message?: CustomMessage): string => (typeof message?.content === "string" ? message.content : "");

describe("ensureSystemToolsActive", () => {
	test("a healthy loadout is untouched and says nothing", () => {
		const { pi, sent } = fakePi({ active: ["read", "memory_write"], registered: ["read", "memory_write"] });
		ensureSystemToolsActive(pi, ["memory_write"]);
		expect(sent).toEqual([]);
		expect(pi.getActiveTools()).toEqual(["read", "memory_write"]);
	});

	test("a frozen tool is re-activated with a visible repair marker", () => {
		const { pi, sent } = fakePi({ active: ["read"], registered: ["read", "memory_write", "ask_user"] });
		ensureSystemToolsActive(pi, ["memory_write", "ask_user"]);
		expect(pi.getActiveTools()).toEqual(["read", "memory_write", "ask_user"]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.customType).toBe("toolset-update");
		expect(markerText(sent[0])).toContain("+memory_write");
		expect(markerText(sent[0])).toContain("+ask_user");
		expect(sent[0]?.details).toEqual({ added: ["memory_write", "ask_user"] });
	});

	test("a tool the host does not register stays absent without repair noise", () => {
		// ask_user is missing from the host registry: the extension is disabled here.
		const { pi, sent } = fakePi({ active: ["read"], registered: ["read", "memory_write"] });
		ensureSystemToolsActive(pi, ["memory_write", "ask_user"]);
		expect(pi.getActiveTools()).toEqual(["read", "memory_write"]);
		// The marker names only the tool that actually came back.
		expect(sent).toHaveLength(1);
		expect(sent[0]?.details).toEqual({ added: ["memory_write"] });
		expect(markerText(sent[0])).not.toContain("ask_user");
	});
});
