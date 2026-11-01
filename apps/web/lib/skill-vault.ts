import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { createSyntheticSourceInfo, type ResourceDiagnostic, type Skill } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "./frontmatter";

/**
 * The machine's dormant skill layer.
 *
 * Skills under `~/.agents/skill-vault/<category>/<name>/SKILL.md` are complete
 * skills that are deliberately kept out of the model's `<available_skills>`
 * list: `skill-nav` indexes them and names the path to read on demand. The
 * loader never scans the vault, so before this module they were invisible to
 * Settings and `/skill:name` only matched the active layer.
 *
 * Registering them as dormant skills gives both without a second source of
 * truth: `formatSkillsForPrompt` drops `disableModelInvocation` skills, while
 * command registration and `/skill:` expansion read the same list.
 */
export function skillVaultRoots(homeDir = homedir()): string[] {
  return [join(homeDir, ".agents", "skill-vault")];
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function isSkillVaultPath(filePath: string, roots: string[] = skillVaultRoots()): boolean {
  return roots.some((root) => isWithin(filePath, root));
}

/** Enough for `<category>/<name>` and one more level; a skill's own folder stops the walk anyway. */
const MAX_VAULT_DEPTH = 4;
const SKILL_FILE = "SKILL.md";

/**
 * Collects one SKILL.md per skill folder.
 *
 * A folder holding SKILL.md is the skill and the walk stops there, so a
 * skill's own reference documents never become skills; a category folder
 * (`lark-suite/`, `machine-fix/`) has no SKILL.md of its own and is walked
 * through. Sorted, so "first copy wins" is stable across platforms.
 */
function collectSkillFiles(dir: string, depth: number, files: string[]): void {
  const skillFile = join(dir, SKILL_FILE);
  if (existsSync(skillFile)) {
    files.push(skillFile);
    return;
  }
  if (depth >= MAX_VAULT_DEPTH) return;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDirectory = statSync(fullPath).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDirectory) collectSkillFiles(fullPath, depth + 1, files);
  }
}

/** A vault document that starts with a heading instead of frontmatter still needs a one-line description. */
function firstParagraph(body: string, fallback: string): string {
  const paragraph: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      if (paragraph.length > 0) break;
      continue;
    }
    // `machine-fix/*` open with a bullet list; keep the words, not the marker.
    paragraph.push(trimmed.replace(/^(?:[-*+]|\d+\.)\s+/, ""));
  }
  const text = paragraph.join(" ").trim();
  return text ? text.slice(0, 1024) : fallback;
}

/**
 * Reads one vault skill. Unlike the active layer, a missing description is not
 * a reason to drop it: the vault is a catalog the user browses, and some of its
 * documents (`machine-fix/*`) are plain Markdown with a title and no
 * frontmatter. The name falls back to the folder, the description to the first
 * paragraph, so the row and `/skill:name` both work.
 */
function readVaultSkill(filePath: string): Skill {
  const baseDir = dirname(filePath);
  const fallbackName = basename(baseDir);
  const content = readFileSync(filePath, "utf8");
  const { data, rest } = parseFrontmatter(content);
  const name = typeof data?.name === "string" && data.name.trim() ? data.name.trim() : fallbackName;
  const description = typeof data?.description === "string" && data.description.trim()
    ? data.description.trim()
    : firstParagraph(rest, name);

  return {
    name,
    description,
    filePath,
    baseDir,
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "user", baseDir }),
    // Dormancy is a property of the layer, not of the file: a vault skill
    // stays out of the prompt whatever its frontmatter says, and activating
    // one means moving it into the active layer, not editing a flag.
    disableModelInvocation: true,
  };
}

export function loadSkillVault(roots: string[] = skillVaultRoots()): {
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
} {
  const skills: Skill[] = [];
  const diagnostics: ResourceDiagnostic[] = [];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const root of roots) {
    if (existsSync(root)) collectSkillFiles(root, 0, files);
  }
  files.sort();
  for (const filePath of files) {
    try {
      const skill = readVaultSkill(filePath);
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      skills.push(skill);
    } catch (error) {
      diagnostics.push({
        type: "warning",
        message: error instanceof Error ? error.message : "skill file unreadable",
        path: filePath,
      });
    }
  }
  return { skills, diagnostics };
}

/**
 * The active layer plus the dormant one, for a resource loader's
 * `skillsOverride`. The active layer keeps its name on a collision.
 */
export function withSkillVault(
  base: {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
  },
  roots: string[] = skillVaultRoots(),
): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const vault = loadSkillVault(roots);
  const taken = new Set(base.skills.map((skill) => skill.name));
  return {
    skills: [...base.skills, ...vault.skills.filter((skill) => !taken.has(skill.name))],
    diagnostics: [...base.diagnostics, ...vault.diagnostics],
  };
}
