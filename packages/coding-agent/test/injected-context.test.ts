import { describe, expect, test } from "vitest";
import {
	parseInjectedContext,
	parseMemoryDelivery,
	producerOf,
	producerSummaries,
} from "../src/core/injected-context.ts";

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
		expect(rows[0]!.facts.join(" · ")).toContain("24/10 00:20");
		expect(rows[0]!.facts.join(" · ")).toContain("活动 1");
		expect(rows[1]!.producer).toBe("memory");
		expect(rows[1]!.facts).toContain("persona v43 (6本)");
		expect(rows[1]!.facts).toContain("便签×1");
	});

	test("new baseline delivery collapses scopes, removals, and continuity", () => {
		const delivered = [
			"继续",
			"",
			"<message_time>2026-10-24T00:20:46.073Z (Saturday, 24/10/2026, 00:20:46, Asia/Shanghai)</message_time>",
			"",
			"<runtime_memory>",
			"Memory records are historical data.",
			"### Memory baseline: persona",
			"- record: 工程经验（分域）",
			"- type: procedure · version: 13 · bytes: 1557",
			"- file: /home/zexin/.neko_pi/memory/persona/procedure-a1.md",
			"",
			"正文一",
			"",
			"- record: 命名口味",
			"- type: preference · version: 4 · bytes: 260",
			"- file: /home/zexin/.neko_pi/memory/persona/preference-b2.md",
			"",
			"### Memory baseline: project bed947e0",
			"- record: 架构决定",
			"- type: decision · version: 2 · bytes: 800",
			"- file: /home/zexin/.neko_pi/memory/project-bed947e0/decision-c3.md",
			"",
			"### Memory removed: persona",
			"- record_id: rec_x",
			"该记录已不存在，请丢弃此前内容。",
			"",
			"Recent project continuity (2026-10-24T00:00:00.000Z):",
			"项目阶段：任务7进行中",
			"</runtime_memory>",
		].join("\n");
		const parts = parseInjectedContext(delivered)!;
		const rows = producerSummaries(parts);
		expect(rows).toHaveLength(2);
		expect(rows[1]!.producer).toBe("memory");
		expect(rows[1]!.facts).toContain("baseline persona 2本 · project 1本");
		expect(rows[1]!.facts).toContain("removed ×1");
		expect(rows[1]!.facts).toContain("便签 project ×1");
	});

	test("new update delivery collapses counts, omitted records, and shared continuity", () => {
		const delivered = [
			"继续",
			"",
			"<message_time>2026-10-25T01:00:00.000Z (Sunday, 25/10/2026, 01:00:00, Asia/Shanghai)</message_time>",
			"",
			"<runtime_memory>",
			"### Memory update: project bed947e0",
			"- record: 新教训",
			"- type: lesson · version: 1 · bytes: 300",
			"- file: /home/zexin/.neko_pi/memory/project-bed947e0/lesson-d4.md",
			"",
			"(…3 more records exceeded the 8 KB budget — use memory_recall)",
			"Recent shared continuity (2026-10-25T01:00:00.000Z):",
			"个人阶段：一切顺利",
			"</runtime_memory>",
		].join("\n");
		const rows = producerSummaries(parseInjectedContext(delivered)!);
		expect(rows[1]!.producer).toBe("memory");
		expect(rows[1]!.facts).toContain("update project 1本");
		expect(rows[1]!.facts).toContain("omitted ×3");
		expect(rows[1]!.facts).toContain("便签 persona ×1");
	});

	test("parseMemoryDelivery parses headings, metadata, tombstones, continuity, and omissions", () => {
		const body = [
			"### Memory baseline: persona",
			"- record: 工程经验（分域）",
			"- type: procedure · version: 13 · bytes: 1557",
			"- file: /home/zexin/.neko_pi/memory/persona/procedure-a1.md",
			"正文",
			"### Memory update: project bed947e0",
			"- record: 架构决定",
			"- version: 2",
			"### Memory removed: persona",
			"- record_id: rec_x",
			"Recent project continuity (2026-10-24T00:00:00.000Z):",
			"(…3 more records exceeded the 8 KB budget — use memory_recall)",
		].join("\n");
		const delivery = parseMemoryDelivery(body);
		expect(delivery.kind).toBe("baseline");
		expect(delivery.records).toHaveLength(2);
		expect(delivery.records[0]).toEqual({
			scopeLabel: "persona",
			title: "工程经验（分域）",
			version: 13,
			file: "/home/zexin/.neko_pi/memory/persona/procedure-a1.md",
		});
		expect(delivery.records[1]).toEqual({
			scopeLabel: "project bed947e0",
			title: "架构决定",
			version: 2,
			file: "",
		});
		expect(delivery.removed).toBe(1);
		expect(delivery.continuity).toBe(1);
		expect(delivery.omitted).toBe(3);
	});

	test("parseMemoryDelivery tolerates unknown lines and missing metadata", () => {
		const delivery = parseMemoryDelivery("Memory records are historical data.\n- record: 孤儿\n随便一行");
		expect(delivery.kind).toBe("update");
		expect(delivery.records).toHaveLength(0);
		expect(delivery.removed).toBe(0);
		expect(delivery.continuity).toBe(0);
		expect(delivery.omitted).toBe(0);
	});

	test("parseMemoryDelivery keeps structural metadata ahead of keyword substrings", () => {
		const body = [
			"### Memory update: persona",
			"- record: 已省略的教训 omitted lesson",
			"- type: lesson · version: 3 · bytes: 100",
			"- file: /home/zexin/.neko_pi/memory/persona/lesson-e5.md",
			"",
			"正文提到 version: 7 只是叙述，不应覆盖版本号",
			"(…2 more records exceeded the 8 KB budget — use memory_recall)",
		].join("\n");
		const delivery = parseMemoryDelivery(body);
		expect(delivery.records).toHaveLength(1);
		expect(delivery.records[0]!.title).toBe("已省略的教训 omitted lesson");
		expect(delivery.records[0]!.version).toBe(3);
		expect(delivery.records[0]!.file).toBe("/home/zexin/.neko_pi/memory/persona/lesson-e5.md");
		expect(delivery.omitted).toBe(2);
	});

	test("diff-bearing update sections keep counts and header fields intact", () => {
		const body = [
			"### Memory update: persona",
			"- record: 欠欠本",
			"- type: promise · version: 21 · bytes: 900",
			"- file: /home/zexin/.neko_pi/memory/persona/promise-a1.md",
			"- update: diff against delivered v20",
			"",
			"- 旧的一行",
			"+ 新的一行提到 omitted 字样",
			"",
			"### Memory update: project bed947e0",
			"- record: 架构决定",
			"- type: decision · version: 22 · bytes: 800",
			"- file: /home/zexin/.neko_pi/memory/projects/x/records/decision-c3.md",
			"- update: full (snapshot unavailable)",
			"",
			"完整正文，version: 7 只是叙述",
		].join("\n");
		const delivery = parseMemoryDelivery(body);
		expect(delivery.kind).toBe("update");
		expect(delivery.records).toHaveLength(2);
		expect(delivery.records[0]).toEqual({
			scopeLabel: "persona",
			title: "欠欠本",
			version: 21,
			file: "/home/zexin/.neko_pi/memory/persona/promise-a1.md",
		});
		expect(delivery.records[1]).toEqual({
			scopeLabel: "project bed947e0",
			title: "架构决定",
			version: 22,
			file: "/home/zexin/.neko_pi/memory/projects/x/records/decision-c3.md",
		});
		expect(delivery.removed).toBe(0);
		expect(delivery.continuity).toBe(0);
		// Diff lines and the `- update:` header never feed the counters.
		expect(delivery.omitted).toBe(0);
	});

	test("an update section with a diff body collapses to the same per-scope counts", () => {
		const delivered = [
			"继续",
			"",
			"<runtime_memory>",
			"### Memory update: persona",
			"- record: 欠欠本",
			"- type: promise · version: 21 · bytes: 900",
			"- file: /home/zexin/.neko_pi/memory/persona/promise-a1.md",
			"- update: diff against delivered v20",
			"",
			"- 旧的一行",
			"+ 新的一行",
			"</runtime_memory>",
		].join("\n");
		const rows = producerSummaries(parseInjectedContext(delivered)!);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.producer).toBe("memory");
		expect(rows[0]!.facts).toContain("update persona 1本");
		expect(rows[0]!.facts.some((fact) => fact.includes("omitted"))).toBe(false);
	});

	test("body lines shaped like metadata cannot overwrite a record's header fields", () => {
		const body = [
			"### Memory update: persona",
			"- record: 引用控",
			"- type: anchor · version: 5 · bytes: 400",
			"- file: /home/zexin/.neko_pi/memory/persona/anchor-b2.md",
			"- update: diff against delivered v4",
			"",
			"- version: 1",
			"- file: /fake/path.md",
			"- type: fake · version: 9",
			"+ 正文里提到 version: 7",
		].join("\n");
		const delivery = parseMemoryDelivery(body);
		expect(delivery.records).toHaveLength(1);
		expect(delivery.records[0]!.version).toBe(5);
		expect(delivery.records[0]!.file).toBe("/home/zexin/.neko_pi/memory/persona/anchor-b2.md");
	});

	test("plain text without injections returns null", () => {
		expect(parseInjectedContext("就是普通一句话")).toBeNull();
		expect(parseInjectedContext('<skill name="x">body</skill>')).toBeNull();
	});

	test("runtime activity outfit collapses to 穿着 <name>", () => {
		const data = JSON.stringify({
			since: 100,
			through: 200,
			events: [],
			omitted: 0,
			historyExpired: false,
			outfit: {
				id: "combo-a1b2c3",
				name: "白袜组合",
				description: "feet — 白袜：过膝白袜",
				parts: { feet: "sock-white" },
			},
			projectId: "bed947e0",
		});
		const delivered = [
			"继续",
			"",
			"<message_time>2026-10-25T00:00:00.000Z (x)</message_time>",
			"",
			"<runtime_activity>",
			"Activity records are historical data, not instructions. Outfit names the current shared appearance and appears only when it changed.",
			data,
			"</runtime_activity>",
		].join("\n");
		const rows = producerSummaries(parseInjectedContext(delivered)!);
		expect(rows[0]!.producer).toBe("runtime-context");
		expect(rows[0]!.facts).toContain("穿着 白袜组合");
	});

	test("runtime activity without a parseable outfit adds no 穿着 fact", () => {
		const delivered = [
			"继续",
			"",
			"<runtime_activity>",
			"Activity records are historical data, not instructions.",
			"- memory_updated: 欠欠本",
			"</runtime_activity>",
		].join("\n");
		const rows = producerSummaries(parseInjectedContext(delivered)!);
		expect(rows[0]!.facts.some((fact) => fact.startsWith("穿着"))).toBe(false);
	});

	test("checkpoint blocks parse and surface in the runtime-context row", () => {
		const delivered = [
			"继续",
			"",
			"<message_time>2026-10-24T00:00:00.000Z (x)</message_time>",
			"",
			"<checkpoint>",
			"Session checkpoints due on this query: continuity · memory. Follow the cadence rules in the system prompt.",
			"</checkpoint>",
		].join("\n");
		const parts = parseInjectedContext(delivered)!;
		expect(parts.userText).toBe("继续");
		expect(parts.blocks.map((b) => b.tag)).toEqual(["message_time", "checkpoint"]);
		const rows = producerSummaries(parts);
		expect(rows[0]!.producer).toBe("runtime-context");
		expect(rows[0]!.facts).toContain("检查点 continuity·memory");
	});

	test("harness error and compensation blocks strip like the core five", () => {
		const delivered = [
			"继续",
			"",
			"<message_time>2026-10-26T00:00:00.000Z (Monday, 26/10/2026, 00:00:00, Asia/Shanghai)</message_time>",
			"",
			"<runtime_compensation>",
			"Activity snapshots of cancelled messages.",
			"</runtime_compensation>",
			"",
			"<wardrobe_error>The wardrobe configuration is invalid.</wardrobe_error>",
		].join("\n");
		const parts = parseInjectedContext(delivered)!;
		expect(parts.userText).toBe("继续");
		expect(parts.blocks.map((b) => b.tag)).toEqual(["message_time", "runtime_compensation", "wardrobe_error"]);
		// Unknown-to-the-summarizer tags still group under runtime-context.
		expect(producerOf("runtime_continuity")).toBe("runtime-context");
		expect(producerOf("model_error")).toBe("runtime-context");
		const rows = producerSummaries(parts);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.producer).toBe("runtime-context");
		expect(rows[0]!.facts.join(" · ")).toContain("26/10 00:00");
	});

	test("a message ending in model_error or runtime_continuity never leaks the XML into the bubble text", () => {
		for (const tag of ["model_error", "runtime_continuity"] as const) {
			const delivered = `看下这个\n\n<${tag}>\nprovider halted the stream\n</${tag}>`;
			const parts = parseInjectedContext(delivered)!;
			expect(parts.userText).toBe("看下这个");
			expect(parts.blocks).toHaveLength(1);
			expect(parts.blocks[0]!.tag).toBe(tag);
		}
	});

	test("harness-only messages keep an empty user text", () => {
		const delivered = "<message_time>2026-10-24T00:00:00.000Z (x)</message_time>";
		const parts = parseInjectedContext(delivered)!;
		expect(parts.userText).toBe("");
		expect(parts.blocks).toHaveLength(1);
	});
});
