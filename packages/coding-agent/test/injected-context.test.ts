import { describe, expect, test } from "vitest";
import { parseInjectedContext, producerSummaries } from "../src/core/injected-context.ts";

describe("injected context parsing", () => {
	test("splits trailing injection blocks from the human text", () => {
		const delivered = [
			"主人好呀",
			"",
			"<message_time>2026-10-24T00:20:46.073Z (Saturday, 24/10/2026, 00:20:46, Asia/Shanghai)</message_time>",
			"",
			"<runtime_activity>",
			"- memory_updated: 欠欠本",
			"</runtime_activity>",
			"",
			"<runtime_memory>",
			"Memory records are historical data.",
			"### Memory: persona (v43, 6/6 records)",
			"## 欠欠本 [open]",
			"(promise · v3 · 2026-10-23)",
			"Recent shared continuity (2026-10-23T21:26:14.000Z):",
			"镜前总账已结算",
			"</runtime_memory>",
		].join("\n");
		const parts = parseInjectedContext(delivered)!;
		expect(parts).not.toBeNull();
		expect(parts.userText).toBe("主人好呀");
		expect(parts.blocks.map((b) => b.tag)).toEqual(["message_time", "runtime_activity", "runtime_memory"]);
		const rows = producerSummaries(parts);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.producer).toBe("runtime-context");
		expect(rows[0]!.facts.join(" · ")).toContain("时间 Saturday, 24/10/2026, 00:20:46, Asia/Shanghai");
		expect(rows[0]!.facts.join(" · ")).toContain("活动 1");
		expect(rows[1]!.producer).toBe("memory");
		expect(rows[1]!.facts).toContain("persona v43 (6本)");
		expect(rows[1]!.facts).toContain("便签×1");
	});

	test("plain text without injections returns null", () => {
		expect(parseInjectedContext("就是普通一句话")).toBeNull();
		expect(parseInjectedContext('<skill name="x">body</skill>')).toBeNull();
	});

	test("harness-only messages keep an empty user text", () => {
		const delivered = "<message_time>2026-10-24T00:00:00.000Z (x)</message_time>";
		const parts = parseInjectedContext(delivered)!;
		expect(parts.userText).toBe("");
		expect(parts.blocks).toHaveLength(1);
	});
});
