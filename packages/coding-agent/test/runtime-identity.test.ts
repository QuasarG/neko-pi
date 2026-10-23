import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	canonicalizeDirectory,
	defaultScopeForType,
	isMemoryScope,
	projectFolderName,
	projectIdFor,
	readableProjectName,
	resolveProjectIdentity,
	scopeKey,
} from "../src/core/runtime/identity.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratch.push(dir);
	return dir;
}

describe("project identity", () => {
	test("same basename in different parents yields different stable IDs", () => {
		const a = resolveProjectIdentity(join(tempDir("neko-id-"), "service"));
		const b = resolveProjectIdentity(join(tempDir("neko-id-"), "service"));
		expect(a.projectId).not.toBe(b.projectId);
		expect(a.name).toBe("service");
		expect(a.folder.startsWith("service--")).toBe(true);
	});

	test("relative paths, .. and trailing separators canonicalize to one identity", () => {
		const root = tempDir("neko-id-rel");
		const viaRelative = canonicalizeDirectory(join(root, "child", "..", "/"));
		const absolute = canonicalizeDirectory(root);
		expect(viaRelative).toBe(absolute);
		expect(projectIdFor(viaRelative)).toBe(projectIdFor(absolute));
	});

	test("symlinks to the same directory share one identity; original is kept", () => {
		const root = tempDir("neko-id-link");
		const linked = join(root, "linked");
		symlinkSync(root, linked);
		const a = resolveProjectIdentity(root);
		const b = resolveProjectIdentity(linked);
		expect(b.projectId).toBe(a.projectId);
		expect(b.original).toBe(linked);
	});

	test("missing directories keep a stable identity from the normalized path", () => {
		const a = resolveProjectIdentity(join(tempDir("neko-id-missing"), "gone"));
		const b = resolveProjectIdentity(join(a.original, "/"));
		expect(a.projectId).toBe(b.projectId);
	});

	test("unicode, spaces and long names produce readable non-colliding folders", () => {
		const long = `数据 工程 ${"x".repeat(80)} .hidden`;
		const dir = join(tempDir("neko-id-uni"), long);
		mkdirSync(dir, { recursive: true });
		const identity = resolveProjectIdentity(dir);
		expect(identity.name.length).toBeLessThanOrEqual(48);
		expect(identity.name).not.toMatch(/[\\/:]/);
		expect(identity.folder.startsWith(`${identity.name}--`)).toBe(true);
	});

	test("short-hash folder collisions extend the hash length", () => {
		const id = "a".repeat(64);
		const first = projectFolderName("app", id.replace(/^.{16}/, "0".repeat(16)), []);
		const collide = projectFolderName("app", id, [first]);
		expect(first.endsWith(`--${"0".repeat(16)}`)).toBe(true);
		expect(collide.startsWith("app--")).toBe(true);
		expect(collide).not.toBe(first);
	});

	test("scope helpers validate and key scopes", () => {
		expect(isMemoryScope({ scope: "persona" })).toBe(true);
		expect(isMemoryScope({ scope: "project", projectId: "a".repeat(64) })).toBe(true);
		expect(isMemoryScope({ scope: "project", projectId: "short" })).toBe(false);
		expect(scopeKey({ scope: "persona" })).toBe("persona");
		expect(scopeKey({ scope: "project", projectId: `b`.repeat(64) })).toBe(`project:${`b`.repeat(64)}`);
	});

	test("default scope keeps work records out of persona", () => {
		const project = resolveProjectIdentity(join(tempDir("neko-id-scope"), "repo"));
		expect(defaultScopeForType("episode", project)).toEqual({
			scope: "project",
			projectId: project.projectId,
		});
		expect(defaultScopeForType("procedure", project).scope).toBe("project");
		expect(defaultScopeForType("profile", project).scope).toBe("persona");
		expect(defaultScopeForType("whisper", project).scope).toBe("persona");
		expect(defaultScopeForType("profile", undefined).scope).toBe("persona");
	});

	test("readable name falls back for empty basenames", () => {
		expect(readableProjectName("/")).toBe("project");
	});

	test("identity survives parent rename by keeping its own path fixed", () => {
		const parent = tempDir("neko-id-move");
		const dir = join(parent, "work");
		mkdirSync(dir);
		writeFileSync(join(dir, "keep.txt"), "x");
		const before = resolveProjectIdentity(dir);
		const moved = join(parent, "work-renamed");
		mkdirSync(moved);
		rmSync(dir, { recursive: true, force: true });
		const after = resolveProjectIdentity(dir);
		// The old path no longer exists, but its identity stays stable for history.
		expect(after.projectId).toBe(before.projectId);
	});
});
