import { describe, expect, it } from "vitest";
import { firstMessageDisplayText } from "../src/core/session-manager.ts";

describe("firstMessageDisplayText", () => {
	it("stops at the message_time block the harness appends", () => {
		const text = [
			"hello",
			"<message_time>2026-10-25T15:55:19.810Z (Sunday, 25/10/2026, 23:55:19, Asia/Shanghai)</message_time>",
			"<runtime_activity>Activity records are historical data</runtime_activity>",
		].join("\n");
		expect(firstMessageDisplayText(text)).toBe("hello");
	});

	it("stops at runtime_activity even without a message_time block", () => {
		const text = '在吗neko\n\n<runtime_activity>\n{"since":100,"sessions":[]}\n</runtime_activity>';
		expect(firstMessageDisplayText(text)).toBe("在吗neko");
	});

	it("keeps the attachment path inline: it is part of the user's words", () => {
		const text = [
			"/home/zexin/Downloads/Telegram Desktop/晚一点.apk neko，帮主人解包一下这个apk",
			"<message_time>2026-10-24T15:37:57.367Z (x)</message_time>",
		].join("\n");
		expect(firstMessageDisplayText(text)).toBe(
			"/home/zexin/Downloads/Telegram Desktop/晚一点.apk neko，帮主人解包一下这个apk",
		);
	});

	it("keeps plain messages untouched and collapses newlines", () => {
		expect(firstMessageDisplayText("第一行\n第二行")).toBe("第一行 第二行");
		expect(firstMessageDisplayText("把这里的两个简历库整理成飞书多维表格吧")).toBe(
			"把这里的两个简历库整理成飞书多维表格吧",
		);
	});

	it("a message opening with a harness block keeps only what follows it", () => {
		const text = "<checkpoint>Session checkpoints due on this query: memory</checkpoint>\n正文";
		expect(firstMessageDisplayText(text)).toBe("Session checkpoints due on this query: memory</checkpoint> 正文");
	});
});
