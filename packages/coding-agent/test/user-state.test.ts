import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { fitMemoryBudget, MEMORY_BUDGET } from "../src/core/memory/budget.ts";
import { ContinuityStore } from "../src/core/memory/continuity.ts";
import { MemoryStore } from "../src/core/memory/store.ts";
import { migrateUserState } from "../src/core/migrate-user-state.ts";
import { finishInit, getInitDraft, runtimeTimeZone, saveInitDraft } from "../src/core/onboarding.ts";
import { TuiBridge } from "../src/modes/tui-bridge/server.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "neko-state-"));
	vi.stubEnv("NEKO_PI_HOME", join(root, "new"));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

it("migrates flattened state, preserves conflicts and archives the complete old directory", () => {
	const old = join(root, "old");
	mkdirSync(join(old, "agent"), { recursive: true });
	mkdirSync(getAgentDir());
	writeFileSync(join(old, "agent", "models.json"), "old config");
	writeFileSync(join(getAgentDir(), "models.json"), "new config");
	writeFileSync(join(old, "agent", "auth.json"), "credential sentinel", { mode: 0o600 });
	migrateUserState(old);
	expect(readFileSync(join(getAgentDir(), "models.json"), "utf8")).toBe("new config");
	expect(readFileSync(join(getAgentDir(), "auth.json"), "utf8")).toBe("credential sentinel");
	expect(existsSync(old)).toBe(false);
	expect(readFileSync(join(getAgentDir(), "migrations", "legacy-pi", "agent", "models.json"), "utf8")).toBe(
		"old config",
	);
	migrateUserState(old);
});

it("leaves protected AGENTS.md at its original location", () => {
	const old = join(root, "old");
	mkdirSync(join(old, "agent"), { recursive: true });
	writeFileSync(join(old, "AGENTS.md"), "protected");
	writeFileSync(join(old, "agent", "models.json"), "{}");
	migrateUserState(old);
	expect(readFileSync(join(old, "AGENTS.md"), "utf8")).toBe("protected");
	expect(existsSync(join(getAgentDir(), "AGENTS.md"))).toBe(false);
});

it("bounds multibyte text and prevents stale or expired continuity", () => {
	const text = "中文🙂".repeat(1000);
	expect(Buffer.byteLength(fitMemoryBudget(text, 301))).toBeLessThanOrEqual(301);
	expect(fitMemoryBudget(text, 301)).not.toContain("�");
	const store = new ContinuityStore(join(root, "memory"));
	const first = store.claim("first");
	expect(store.commit(first, text)).toBe(true);
	const second = store.claim("second");
	expect(store.commit(first, "stale")).toBe(false);
	expect(Buffer.byteLength(store.context())).toBeLessThanOrEqual(MEMORY_BUDGET.continuity);
	expect(store.commit(second, "current confirmed state")).toBe(true);
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
	expect(store.context()).toBe("");
});

it("resumes onboarding and installs generic global identity and timezone", () => {
	const draft = {
		step: 2,
		name: "Resident",
		identity: "A patient guide.",
		voice: "Short clear answers.",
		timeZone: "Asia/Shanghai",
	};
	saveInitDraft(draft);
	expect(getInitDraft()).toEqual(draft);
	finishInit(draft);
	expect(readFileSync(join(getAgentDir(), "persona", "persona.md"), "utf8")).toBe(draft.identity);
	expect(runtimeTimeZone()).toBe("Asia/Shanghai");
	expect(() => finishInit({ ...draft, identity: "" })).toThrow();
	expect(() => saveInitDraft({ ...draft, timeZone: "invalid/timezone" })).toThrow();
});

it("does not collide by record type, keeps archived content searchable and caps standing context", () => {
	const store = new MemoryStore(join(root, "memory"));
	store.write({ type: "profile", title: "饮茶偏好", body: "主人喜欢茉莉花茶。".repeat(200), source: "model" });
	store.write({ type: "promise", title: "饮茶偏好", body: "明天买茉莉花茶。", source: "model" });
	expect(store.list(true)).toHaveLength(2);
	expect(store.recall("喜欢什么花茶").length).toBeGreaterThan(0);
	expect(Buffer.byteLength(store.buildStandingContext())).toBeLessThanOrEqual(MEMORY_BUDGET.standing);
});

it("restores bridge history and queued messages after a restart without executing them automatically", async () => {
	const stateDir = join(root, "sessions");
	mkdirSync(stateDir);
	writeFileSync(
		join(stateDir, "ses_saved.json"),
		JSON.stringify({
			id: "ses_saved",
			agent: "build",
			directory: root,
			title: "Saved conversation",
			created: 1,
			updated: 2,
			seq: 3,
			messages: [{ id: "queued", role: "user", text: "Pending message", time: 2, delivery: "queue" }],
			history: [{ id: "first", type: "user", text: "Earlier message", time: { created: 1 } }],
		}),
	);
	const createAgent = vi.fn();
	const bridge = new TuiBridge({ stateDir, createAgent, onLog: () => {} });
	const port = await bridge.listen();
	try {
		const base = `http://127.0.0.1:${port}/api/session/ses_saved`;
		expect(await (await fetch(`${base}/message`)).json()).toMatchObject({ data: [{ text: "Earlier message" }] });
		expect(await (await fetch(`${base}/inbox`)).json()).toMatchObject({
			data: [{ payload: { text: "Pending message" } }],
		});
		expect(await (await fetch(base)).json()).toMatchObject({ data: { outcome: "interrupted" } });
		expect(createAgent).not.toHaveBeenCalled();
	} finally {
		await bridge.close();
	}
});
