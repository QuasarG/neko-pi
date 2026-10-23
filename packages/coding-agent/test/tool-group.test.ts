import { describe, expect, test } from "vitest";

/**
 * The tool-group summary line is a pure projection of a completed assistant
 * message's toolCall parts. The interactive-mode method is private and TUI
 * bound, so the projection logic is mirrored here against the real message
 * shape; keep both in sync when categories change.
 */
const categoryOf = (tool: string): string => {
	if (tool === "read") return "读取";
	if (tool === "glob" || tool === "grep" || tool === "list") return "查找";
	if (tool === "write" || tool === "edit") return "修改";
	if (tool === "bash") return "命令";
	if (tool === "webfetch") return "网络";
	return "工具";
};

function groupLine(names: string[]): string | undefined {
	if (names.length < 3) return undefined;
	const counts = new Map<string, number>();
	for (const name of names) {
		const kind = categoryOf(name);
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	const top = ranked
		.slice(0, 3)
		.map(([kind, count]) => `${kind}×${count}`)
		.join(" · ");
	const more = ranked.length > 3 ? ` 等${ranked.length}类` : "";
	return `⟐ ${names.length} 次调用 · ${top}${more}`;
}

describe("tool group summary", () => {
	test("ranks the top three categories with counts", () => {
		const names = ["read", "read", "bash", "grep", "edit", "read", "bash"];
		expect(groupLine(names)).toBe("⟐ 7 次调用 · 读取×3 · 命令×2 · 查找×1 · 修改×1");
	});

	test("under three calls stays silent", () => {
		expect(groupLine(["read", "bash"])).toBeUndefined();
	});

	test("unknown tools fall into the generic bucket", () => {
		expect(groupLine(["memory_write", "wardrobe", "stylebank"])).toBe("⟐ 3 次调用 · 工具×3");
	});
});
