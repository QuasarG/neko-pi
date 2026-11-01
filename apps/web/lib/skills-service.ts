import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { isSkillVaultPath, skillVaultRoots, withSkillVault } from "@/lib/skill-vault";
import { getProjectTrustStatus, projectTrustReloadOptions } from "@/lib/project-trust";

export async function loadSkillsWithInstallInfo(cwd: string): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  // Extensions add skills only through `resources_discover` at session_start,
  // which a listing never runs, so loading them here would only import every
  // extension for nothing (#1226).
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, skillsOverride: withSkillVault });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  const { skills, diagnostics } = loader.getSkills();
  // The dormant layer is listed with the rest — this panel is the only place
  // the whole skill set is visible — but marked, because its rows cannot be
  // switched into the prompt.
  const vaultRoots = skillVaultRoots();
  return {
    skills: annotateSkillsWithInstallInfo(skills as SkillInfo[], { cwd, agentDir }).map((skill) =>
      isSkillVaultPath(skill.filePath, vaultRoots) ? { ...skill, layer: "vault" as const } : skill,
    ),
    diagnostics,
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}
