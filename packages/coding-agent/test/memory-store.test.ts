import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/core/memory/store.ts";

describe("memory store", () => {
	let dir: string;
	let store: MemoryStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "neko-memory-"));
		store = new MemoryStore(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("write creates a readable record file and list round-trips it", () => {
		const result = store.write({
			type: "promise",
			title: "reward after launch",
			body: "Promised celebration once shipped.",
			source: "model",
		});
		expect(result.action).toBe("created");
		const raw = readFileSync(join(dir, result.file), "utf-8");
		expect(raw).toContain("type: promise");
		expect(raw).toContain("title: reward after launch");
		const record = store.list(true).find((r) => r.title === "reward after launch");
		expect(record?.type).toBe("promise");
		expect(record?.salience).toBe(0.9);
		expect(record?.status).toBe("open");
	});

	test("same type+title merges instead of duplicating", () => {
		store.write({ type: "episode", title: "deploy day", body: "first attempt", source: "model" });
		const second = store.write({ type: "episode", title: "deploy day", body: "second attempt", source: "model" });
		expect(second.action).toBe("merged");
		const records = store.list(true).filter((r) => r.title === "deploy day");
		expect(records).toHaveLength(1);
		expect(records[0]!.body).toContain("second attempt");
		expect(records[0]!.body).not.toContain("first attempt");
		expect(readFileSync(join(dir, "history", readdirSync(join(dir, "history"))[0]!), "utf8")).toContain(
			"first attempt",
		);
	});

	test("recent hook duplicates are rejected but user commands always land", () => {
		store.write({ type: "episode", title: "night build", body: "v1", source: "hook" });
		const hookAgain = store.write({ type: "episode", title: "night build", body: "v2", source: "hook" });
		expect(hookAgain.action).toBe("rejected");
		const userWrite = store.write({ type: "episode", title: "night build", body: "v3", source: "user" });
		expect(userWrite.action).toBe("merged");
	});

	test("recall scores matches and boosts open promises", () => {
		store.write({ type: "episode", title: "database migration", body: "migrated postgres", source: "model" });
		store.write({
			type: "promise",
			title: "review database schema",
			body: "promise to review",
			source: "model",
			status: "open",
		});
		store.write({ type: "episode", title: "unrelated picnic", body: "sandwiches", source: "model" });
		const results = store.recall("database schema");
		expect(results.map((r) => r.record.title)).toContain("review database schema");
		expect(results[0]!.record.title).toBe("review database schema");
		expect(results.some((r) => r.record.title === "unrelated picnic")).toBe(false);
	});

	test("consolidate archives decayed episodes without losing their body", () => {
		store.write({ type: "episode", title: "old sprint", body: "line one\nline two\nline three", source: "model" });
		const file = store.list(true)[0]!.file!;
		const stale = new Date(Date.now() - 75 * 86_400_000).toISOString();
		const raw = readFileSync(join(dir, file), "utf-8").replace(/^updated: .*$/m, `updated: ${stale}`);
		writeFileSync(join(dir, file), raw);
		const archived = store.consolidate();
		expect(archived).toHaveLength(1);
		const remaining = store.list(true).filter((r) => r.title === "old sprint");
		expect(remaining).toHaveLength(0);
		const archivedRaw = readFileSync(join(dir, "archive", file), "utf-8");
		expect(archivedRaw).toContain("archived: true");
		expect(archivedRaw).toContain("line one");
		expect(archivedRaw).toContain("line three");
	});

	test("records carry stable ids, versions and scoped file names", () => {
		store.write({ type: "profile", title: "user profile", body: "Prefers concise answers.", source: "model" });
		store.write({
			type: "promise",
			title: "ship by friday",
			body: "delivery commitment",
			source: "model",
			status: "open",
		});
		const profile = store.list(true).find((r) => r.type === "profile")!;
		expect(profile.id).toMatch(/^rec_[0-9a-f]{12}$/);
		expect(profile.version).toBe(1);
		expect(profile.file).toBe(`profile-user-profile--${profile.id!.replace("rec_", "")}.md`);
		const again = store.write({ type: "profile", title: "user profile", body: "Updated.", source: "model" });
		expect(again.action).toBe("merged");
		expect(store.list(true).find((r) => r.type === "profile")!.version).toBe(2);
	});

	test("human edits on disk are picked up on reload", () => {
		store.write({ type: "procedure", title: "deploy ritual", body: "run tests first", source: "model" });
		const file = store.list(true)[0]!.file!;
		const raw = readFileSync(join(dir, file), "utf-8").replace("run tests first", "run tests, then deploy");
		writeFileSync(join(dir, file), raw);
		expect(store.list(true)[0]!.body).toContain("then deploy");
	});
});
