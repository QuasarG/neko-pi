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

/** A memory scope: global persona, or one project's working memory. */
export type MemoryScope = { scope: "persona" } | { scope: "project"; projectId: string };

export function isMemoryScope(value: unknown): value is MemoryScope {
	if (!value || typeof value !== "object") return false;
	const scope = value as { scope?: unknown; projectId?: unknown };
	if (scope.scope === "persona") return true;
	return scope.scope === "project" && typeof scope.projectId === "string" && /^[0-9a-f]{64}$/.test(scope.projectId);
}

/** Scope key used for storage rows: `persona` or `project:<id>`. */
export function scopeKey(scope: MemoryScope): string {
	return scope.scope === "persona" ? "persona" : `project:${scope.projectId}`;
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

/** Default scope for a memory write that did not specify one. */
export function defaultScopeForType(type: string, project: ProjectIdentity | undefined): MemoryScope {
	// Work-context records default to the current project; user-facing records
	// stay global. Explicit scope always wins over this fallback.
	if (project && (type === "episode" || type === "procedure"))
		return { scope: "project", projectId: project.projectId };
	return { scope: "persona" };
}
