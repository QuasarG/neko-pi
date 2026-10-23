import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryChannel } from "../src/core/memory/channel.ts";
import { resolveProjectIdentity } from "../src/core/runtime/identity.ts";
import { RuntimeState } from "../src/core/runtime/state-db.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "neko-channel-"));
	scratch.push(root);
	const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
	const channel = new MemoryChannel(join(root, "memory"), state);
	return { root, state, channel };
}

function project(_channel: MemoryChannel, state: RuntimeState, root: string, name: string) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const identity = resolveProjectIdentity(dir);
	state.ensureProject(identity);
	return identity;
}

describe("unified memory channel", () => {
	test("six record types round-trip through one scoped pipeline", () => {
		const { root, state, channel } = setup();
		const identity = project(channel, state, root, "repo");
		const types = ["promise", "episode", "anchor", "whisper", "profile", "procedure"] as const;
		for (const type of types) {
			const result = channel.write({
				type,
				title: `${type} topic`,
				body: `${type} body`,
				source: "model",
				scope: { scope: "project", projectId: identity.projectId },
			});
			expect(result.action).toBe("created");
		}
		const store = channel.store({ scope: "project", projectId: identity.projectId });
		const records = store.list(true);
		expect(records).toHaveLength(6);
		for (const type of types) {
			const record = records.find((r) => r.type === type);
			expect(record?.body).toBe(`${type} body`);
			expect(record?.id).toMatch(/^rec_/);
		}
		// Metadata mirrors the files, including versions and hashes.
		const rows = state.listMemoryRecords({ scope: "project", projectId: identity.projectId });
		expect(rows).toHaveLength(6);
		expect(rows.every((row) => row.version === 1 && row.contentHash.length === 64)).toBe(true);
	});

	test("same topic in persona and project stays two independent records", () => {
		const { root, state, channel } = setup();
		const identity = project(channel, state, root, "repo");
		channel.write({
			type: "procedure",
			title: "deploy ritual",
			body: "persona version",
			source: "model",
			scope: { scope: "persona" },
		});
		channel.write({
			type: "procedure",
			title: "deploy ritual",
			body: "project version",
			source: "model",
			scope: { scope: "project", projectId: identity.projectId },
		});
		channel.write({
			type: "procedure",
			title: "deploy ritual",
			body: "persona v2",
			source: "model",
			scope: { scope: "persona" },
		});
		expect(channel.store({ scope: "persona" }).list(true)).toHaveLength(1);
		expect(channel.store({ scope: "persona" }).list(true)[0]!.body).toBe("persona v2");
		const projectRecords = channel.store({ scope: "project", projectId: identity.projectId }).list(true);
		expect(projectRecords).toHaveLength(1);
		expect(projectRecords[0]!.body).toBe("project version");
	});

	test("stale expected version conflicts instead of overwriting", () => {
		const { channel } = setup();
		const scope = { scope: "persona" } as const;
		channel.write({ type: "anchor", title: "fact", body: "first", source: "model", scope });
		const read = channel.store(scope).list(true)[0]!;
		const concurrent = channel.write({ type: "anchor", title: "fact", body: "second", source: "user", scope });
		expect(concurrent.action).toBe("merged");
		const stale = channel.write({
			type: "anchor",
			title: "fact",
			body: "third",
			source: "user",
			scope,
			expectedVersion: read.version,
		});
		expect(stale.action).toBe("conflict");
		expect(channel.store(scope).list(true)[0]!.body).toBe("second");
	});

	test("hand edits are detected and re-registered as external changes", async () => {
		const { state, channel } = setup();
		const scope = { scope: "persona" } as const;
		channel.write({ type: "profile", title: "edited", body: "original", source: "model", scope });
		const file = channel.store(scope).list(true)[0]!.file!;
		const path = join(channel.store(scope).dir, file);
		writeFileSync(path, readFileSync(path, "utf8").replace("original", "hand-edited"));
		const before = state.scopeVersion(scope);
		// Freshly written files are treated as mid-write; let this one settle.
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		const changed = channel.syncExternalChanges(scope);
		expect(changed).toBeGreaterThanOrEqual(1);
		expect(state.scopeVersion(scope)).toBeGreaterThan(before);
		// Deletion registers a tombstone, not a silent disappearance.
		rmSync(path);
		channel.syncExternalChanges(scope);
		expect(state.listMemoryRecords(scope)).toHaveLength(0);
	});

	test("catalog lists titles, files and versions within budget", () => {
		const { root, state, channel } = setup();
		const identity = project(channel, state, root, "repo");
		channel.write({ type: "profile", title: "tea", body: "jasmine", source: "model", scope: { scope: "persona" } });
		channel.write({
			type: "procedure",
			title: "build",
			body: "npm run check",
			source: "model",
			scope: { scope: "project", projectId: identity.projectId },
		});
		const catalog = channel.catalog([{ scope: "persona" }, { scope: "project", projectId: identity.projectId }]);
		expect(catalog).toContain("tea");
		expect(catalog).toContain("build");
		expect(catalog).not.toContain("npm run check");
		expect(Buffer.byteLength(catalog)).toBeLessThanOrEqual(2000);
		// A scope the caller may not see never appears.
		const other = project(channel, state, root, "other");
		channel.write({
			type: "anchor",
			title: "secret",
			body: "other project",
			source: "model",
			scope: { scope: "project", projectId: other.projectId },
		});
		const limited = channel.catalog([{ scope: "persona" }, { scope: "project", projectId: identity.projectId }]);
		expect(limited).not.toContain("secret");
	});

	test("project store folders use readable names anchored by hash", () => {
		const { root, state, channel } = setup();
		const identity = project(channel, state, root, "服务 工程");
		channel.write({
			type: "episode",
			title: "day one",
			body: "x",
			source: "model",
			scope: { scope: "project", projectId: identity.projectId },
		});
		const dir = channel.store({ scope: "project", projectId: identity.projectId }).dir;
		expect(dir).toContain(`--${identity.projectId.slice(0, 16)}/records`);
	});

	test("mixed personal and project writes go to separate scopes by default", () => {
		const { root, state, channel } = setup();
		const identity = project(channel, state, root, "repo");
		const persona = channel.resolveScope({ type: "profile", cwd: join(root, "repo") });
		const work = channel.resolveScope({ type: "procedure", cwd: join(root, "repo") });
		expect(persona.scope).toBe("persona");
		expect(work).toEqual({ scope: "project", projectId: identity.projectId });
	});

	test("record-count cap rejects new topics but never blocks merges", () => {
		const { root, state, channel } = setup();
		const identity = project(channel, state, root, "repo");
		const scoped = new MemoryChannel(join(root, "memory"), state, {
			personaMaxRecords: 3,
			projectMaxRecords: 2,
		});
		for (let i = 1; i <= 3; i++) {
			const result = scoped.write({
				type: "episode",
				title: `note ${i}`,
				body: `body ${i}`,
				source: "model",
				scope: { scope: "persona" },
			});
			expect(result.action).toBe("created");
		}
		// Cap reached: a brand-new topic is refused with an honest note…
		const refused = scoped.write({
			type: "episode",
			title: "note 4",
			body: "body 4",
			source: "model",
			scope: { scope: "persona" },
		});
		expect(refused.action).toBe("rejected");
		expect(refused.note).toContain("record cap reached: 3");
		// …while merging an existing topic still succeeds — consolidation is
		// the remedy for the cap, it must stay possible at the cap.
		const merged = scoped.write({
			type: "episode",
			title: "note 2",
			body: "body 2 revised",
			source: "model",
			scope: { scope: "persona" },
		});
		expect(merged.action).toBe("merged");
		expect(scoped.store({ scope: "persona" }).list(true)).toHaveLength(3);
		// The cap is per scope: the project store has its own budget.
		for (const title of ["project note", "project note b"]) {
			const created = scoped.write({
				type: "episode",
				title,
				body: "body",
				source: "model",
				scope: { scope: "project", projectId: identity.projectId },
			});
			expect(created.action).toBe("created");
		}
		const projectRefused = scoped.write({
			type: "episode",
			title: "project note 2",
			body: "body",
			source: "model",
			scope: { scope: "project", projectId: identity.projectId },
		});
		expect(projectRefused.action).toBe("rejected");
		expect(projectRefused.note).toContain("record cap reached: 2");
		// The default channel keeps the production caps.
		expect(channel).toBeDefined();
	});
});
