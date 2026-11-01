/**
 * Project identity: canonical directory, stable ID, and memory scope contract.
 *
 * A project is identified by the SHA-256 of its canonical path bytes, so two
 * directories with the same basename stay separate projects, a symlink and its
 * target merge into one, and renaming keeps the old identity until the user
 * explicitly relinks it. The readable name exists only for humans; the hash is
 * the identity.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

export interface ProjectIdentity {
	/** Full SHA-256 hex of the canonical path. This is the identity. */
	projectId: string;
	/** Canonical path used for hashing: absolute, realpath-resolved, forward slashes. */
	canonical: string;
	/** The path as originally supplied, kept for display and debugging. */
	original: string;
	/** Readable directory name (basename), sanitized for filesystem use. */
	name: string;
	/** Storage folder name: `<name>--<hash prefix>`. */
	folder: string;
}

/**
 * A memory scope: global persona, the person's cross-project toolbox, one
 * project's working memory, or durable facts whose owning project is not yet
 * known (scratch).
 */
export type MemoryScope =
	| { scope: "persona" }
	| { scope: "toolbox" }
	| { scope: "project"; projectId: string }
	| { scope: "scratch" };

/** Shelves every session sees, regardless of working directory. */
export const GLOBAL_SCOPES: MemoryScope[] = [{ scope: "persona" }, { scope: "toolbox" }];

export function isMemoryScope(value: unknown): value is MemoryScope {
	if (!value || typeof value !== "object") return false;
	const scope = value as { scope?: unknown; projectId?: unknown };
	if (scope.scope === "persona" || scope.scope === "toolbox" || scope.scope === "scratch") return true;
	return scope.scope === "project" && typeof scope.projectId === "string" && /^[0-9a-f]{64}$/.test(scope.projectId);
}

/** Scope key used for storage rows: `persona`, `toolbox`, `scratch`, or `project:<id>`. */
export function scopeKey(scope: MemoryScope): string {
	if (scope.scope === "persona") return "persona";
	if (scope.scope === "toolbox") return "toolbox";
	if (scope.scope === "scratch") return "scratch";
	return `project:${scope.projectId}`;
}

/** Separator-free canonical form: absolute, realpath when it exists, `/` separators. */
export function canonicalizeDirectory(directory: string): string {
	// resolve() also normalizes absolute inputs: trailing separators, `..`, double slashes.
	const absolute = resolve(directory);
	let canonical = absolute;
	try {
		canonical = realpathSync(absolute);
	} catch {
		// Missing directory keeps the normalized path; identity stays stable for old sessions.
	}
	return canonical.split(sep).join("/");
}

export function projectIdFor(canonical: string): string {
	return createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex");
}

/** Sanitize a basename into a readable, filesystem-safe folder fragment. */
export function readableProjectName(canonical: string): string {
	const raw = canonical.split("/").filter(Boolean).at(-1) ?? "project";
	const cleaned = raw
		.replace(/[^\p{L}\p{N}._-]+/gu, "-")
		.replace(/^[-.]+|[-]+$/gu, "")
		.slice(0, 48);
	return cleaned || "project";
}

/**
 * Folder name for a project under `memory/projects/`. `taken` holds existing
 * sibling folder names; on a short-hash collision the hash length grows until
 * the name is unambiguous.
 */
export function projectFolderName(name: string, projectId: string, taken: Iterable<string> = []): string {
	const takenSet = new Set(taken);
	for (let length = 16; length <= 64; length += 8) {
		const candidate = `${name}--${projectId.slice(0, length)}`;
		if (!takenSet.has(candidate)) return candidate;
	}
	return `${name}--${projectId}`;
}

export function resolveProjectIdentity(directory: string, takenFolders: Iterable<string> = []): ProjectIdentity {
	const canonical = canonicalizeDirectory(directory);
	const projectId = projectIdFor(canonical);
	const name = readableProjectName(canonical);
	return {
		projectId,
		canonical,
		original: directory,
		name,
		folder: projectFolderName(name, projectId, takenFolders),
	};
}

/**
 * Whether `directory` is the user's home directory. Home sessions are general
 * tasks, not a project: work knowledge there defaults to the toolbox and the
 * project shelf is not writable.
 */
export function isHomeDirectory(directory: string): boolean {
	return canonicalizeDirectory(directory) === canonicalizeDirectory(homedir());
}

/** Default scope for a memory write that did not specify one. */
export function defaultScopeForType(type: string, project: ProjectIdentity | undefined): MemoryScope {
	// The routing contract in the tool description, in one line: work knowledge
	// that only matters to the current project lives in that project; work
	// knowledge that travels with the person lives in the toolbox; everything
	// user-facing stays global. Home is not a project, so its work knowledge
	// defaults to the toolbox. Episodes are the couple's diary: they belong to
	// persona everywhere — a project never receives them by default.
	if (type === "procedure" && project && !isHomeDirectory(project.canonical)) {
		return { scope: "project", projectId: project.projectId };
	}
	if (type === "procedure") return { scope: "toolbox" };
	return { scope: "persona" };
}
