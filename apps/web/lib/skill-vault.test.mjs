import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { isSkillVaultPath, loadSkillVault, skillVaultRoots, withSkillVault } = await createJiti(import.meta.url)
  .import("./skill-vault.ts");

// R59: the dormant layer (skill-vault) is listed and invocable as /skill:name,
// but never enters the model's <available_skills> catalog.

async function skill(dir, name, extra = "") {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n${extra}`);
}

async function withVault(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skill-vault-"));
  const vault = join(root, ".agents", "skill-vault");
  try {
    await run({ root, vault });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const active = (name) => ({
  name,
  description: `${name} skill`,
  filePath: `/active/${name}/SKILL.md`,
  baseDir: `/active/${name}`,
  disableModelInvocation: false,
  sourceInfo: { source: "local", scope: "user" },
});

test("a vault category and a vault skill both resolve, and every vault skill is dormant", async () => {
  await withVault(async ({ vault }) => {
    // Category folder without SKILL.md, then a skill folder with one.
    await skill(join(vault, "lark-suite"), "lark-doc");
    await skill(join(vault, "motion", "gsap-core"), "gsap-core");
    // A reference document next to SKILL.md is not a second skill.
    await skill(join(vault, "motion", "gsap-core", "references"), "not-a-skill");

    const loaded = loadSkillVault([vault]);
    assert.deepEqual(loaded.skills.map((item) => item.name).sort(), ["gsap-core", "lark-doc"]);
    for (const item of loaded.skills) {
      assert.equal(item.disableModelInvocation, true, `${item.name} stays dormant`);
    }
  });
});

test("a vault document without frontmatter still gets a name and a description", async () => {
  await withVault(async ({ vault }) => {
    const dir = join(vault, "machine-fix", "chrome-emoji-fix");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "# Skill: chrome-emoji-fix\n\nChrome shows tofu blocks after a font change.\n\n## Fix\n");

    const loaded = loadSkillVault([vault]);
    const skill = loaded.skills.find((item) => item.filePath === join(dir, "SKILL.md"));
    assert.ok(skill, "listed, not dropped for the missing frontmatter");
    assert.equal(skill.name, "chrome-emoji-fix");
    assert.equal(skill.description, "Chrome shows tofu blocks after a font change.");
    assert.equal(skill.disableModelInvocation, true);
  });
});

test("the active layer wins a name collision and the vault keeps one copy", async () => {
  await withVault(async ({ vault }) => {
    await skill(join(vault, "a"), "same");
    await skill(join(vault, "b"), "same");
    await skill(join(vault, "c"), "vault-only");

    const merged = withSkillVault({ skills: [active("same"), active("active-only")], diagnostics: [] }, [vault]);
    assert.deepEqual(merged.skills.map((item) => item.name).sort(), ["active-only", "same", "vault-only"]);
    const winner = merged.skills.find((item) => item.name === "same");
    assert.equal(winner.filePath, "/active/same/SKILL.md");
    assert.equal(winner.disableModelInvocation, false);
  });
});

test("the dormant layer never reaches the prompt catalog", async () => {
  await withVault(async ({ vault }) => {
    await skill(join(vault, "lark-suite"), "lark-doc");
    const merged = withSkillVault({ skills: [active("memory-hygiene")], diagnostics: [] }, [vault]);

    const prompt = formatSkillsForPrompt(merged.skills);
    assert.match(prompt, /<name>memory-hygiene<\/name>/);
    assert.doesNotMatch(prompt, /lark-doc/);
    // Invocation still finds it: that is the lookup /skill:lark-doc performs.
    assert.ok(merged.skills.some((item) => item.name === "lark-doc"));
  });
});

test("vault paths are recognized by directory, not by name prefix", async () => {
  await withVault(async ({ root, vault }) => {
    assert.deepEqual(skillVaultRoots(root), [vault]);
    assert.equal(isSkillVaultPath(join(vault, "a", "SKILL.md"), [vault]), true);
    assert.equal(isSkillVaultPath(join(root, ".agents", "skill-vault-copy", "a", "SKILL.md"), [vault]), false);
    assert.equal(isSkillVaultPath(join(root, "active", "a", "SKILL.md"), [vault]), false);
  });
});

test("a missing vault is just an empty layer", () => {
  const loaded = loadSkillVault(["/does/not/exist/skill-vault"]);
  assert.deepEqual(loaded.skills, []);
  assert.deepEqual(loaded.diagnostics, []);
});
