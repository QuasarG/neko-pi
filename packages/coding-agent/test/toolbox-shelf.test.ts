import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryChannel } from "../src/core/memory/channel.ts";
import { buildMemoryDelivery } from "../src/core/memory/delivery.ts";
import { defaultScopeForType, resolveProjectIdentity } from "../src/core/runtime/identity.ts";
import { RuntimeState } from "../src/core/runtime/state-db.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "neko-toolbox-"));
	dirs.push(root);
	const state = new RuntimeState(join(root, "runtime", "state.sqlite"));
	const channel = new MemoryChannel(join(root, "memory"), state);
	return { root, state, channel };
}

describe("default routing", () => {
	test("procedures default to the project inside a project and to the toolbox at $HOME", () => {
		const repo = mkdtempSync(join(tmpdir(), "neko-toolbox-repo-"));
		dirs.push(repo);
		const inProject = defaultScopeForType("procedure", resolveProjectIdentity(repo));
		expect(inProject).toEqual({ scope: "project", projectId: resolveProjectIdentity(repo).projectId });
		// Home sessions are general tasks: work knowledge goes to the toolbox,
		// episodes are the couple's diary and default to persona everywhere.
		expect(defaultScopeForType("procedure", resolveProjectIdentity(homedir()))).toEqual({ scope: "toolbox" });
		expect(defaultScopeForType("episode", resolveProjectIdentity(homedir()))).toEqual({ scope: "persona" });
		expect(defaultScopeForType("episode", resolveProjectIdentity(repo))).toEqual({ scope: "persona" });
		expect(defaultScopeForType("profile", resolveProjectIdentity(repo))).toEqual({ scope: "persona" });
	});

	test("explicit project writes in the home directory are refused with the right destinations", () => {
		const { channel } = setup();
		expect(() => channel.resolveScope({ scope: "project", type: "procedure", cwd: homedir() })).toThrow(
			/toolbox.*persona|persona.*toolbox/s,
		);
		// The same write in a real project still works.
		const repo = mkdtempSync(join(tmpdir(), "neko-toolbox-repo2-"));
		dirs.push(repo);
		expect(channel.resolveScope({ scope: "project", type: "procedure", cwd: repo })).toMatchObject({
			scope: "project",
		});
	});
});

describe("cross-shelf guards", () => {
	test("a stale expected_version names the sibling copy instead of claiming deletion", () => {
		const { channel } = setup();
		channel.write({
			type: "procedure",
			title: "shared topic",
			body: "body",
			source: "model",
			scope: { scope: "persona" },
		});
		const blocked = channel.write({
			type: "procedure",
			title: "shared topic",
			body: "new body",
			source: "model",
			scope: { scope: "toolbox" },
			expectedVersion: 1,
		});
		expect(blocked.action).toBe("conflict");
		expect(blocked.note).toContain('persona copy of "shared topic"');
		expect(blocked.note).toContain("scope=persona");
		expect(blocked.note).toContain("omit expected_version");
		// Following the hint's first branch updates the real copy in one call.
		const fixed = channel.write({
			type: "procedure",
			title: "shared topic",
			body: "new body",
			source: "model",
			scope: { scope: "persona" },
			expectedVersion: 1,
		});
		expect(fixed.action).toBe("merged");
	});

	test("creating a same-topic record on a sibling shelf carries a duplicate notice", () => {
		const { channel } = setup();
		channel.write({
			type: "procedure",
			title: "deploy notes",
			body: "v1",
			source: "model",
			scope: { scope: "toolbox" },
		});
		const duplicate = channel.write({
			type: "procedure",
			title: "deploy notes",
			body: "v1",
			source: "model",
			scope: { scope: "persona" },
		});
		expect(duplicate.action).toBe("created");
		expect(duplicate.note).toContain("same-topic record exists in toolbox");
		// The notice is informational: the record really did land.
		expect(channel.store({ scope: "persona" }).list(true)).toHaveLength(1);
	});
});

describe("toolbox shelf", () => {
	test("round-trips writes and stays visible to any session like persona", () => {
		const { root, state, channel } = setup();
		const written = channel.write({
			type: "procedure",
			title: "lark-cli pitfalls",
			body: "always pass --user-token",
			source: "model",
			scope: { scope: "toolbox" },
		});
		expect(written.action).toBe("created");
		expect(state.listMemoryRecords({ scope: "toolbox" })).toHaveLength(1);

		const projectDir = join(root, "repo");
		const projectScope = { scope: "project" as const, projectId: resolveProjectIdentity(projectDir).projectId };
		const delivery = buildMemoryDelivery({ sessionId: "s-anywhere", projectScope, channel });
		const heads = delivery.sections.map((section) => section.split("\n")[0]);
		expect(heads).toContain("### Memory baseline: toolbox");
		expect(delivery.sections.join("\n")).toContain("--user-token");
	});

	test("promoting a scratch record to the toolbox lands on the global shelf", () => {
		const { state, channel } = setup();
		channel.write({
			type: "anchor",
			title: "server fact",
			body: "182 is personal",
			source: "model",
			scope: { scope: "scratch" },
			originSessionId: "s1",
			originCwd: "/w",
		});
		const id = channel.store({ scope: "scratch" }).list(true)[0]!.id!;
		const promoted = channel.promote({ recordId: id, target: { scope: "toolbox" } });
		expect(promoted.action).toBe("created");
		expect(
			channel
				.store({ scope: "toolbox" })
				.list(true)
				.map((record) => record.title),
		).toContain("server fact");
		expect(channel.store({ scope: "scratch" }).list(true)).toHaveLength(0);
		expect(state.getMemoryRecord({ scope: "toolbox" }, id)).toBeDefined();
	});
});
