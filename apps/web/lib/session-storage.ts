import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ENV_SESSION_DIR, expandTildePath } from "@earendil-works/pi-coding-agent/runtime";
import { join, resolve } from "node:path";

/** Native CLI precedence: environment, then project/global settings, then the default layout. */
export function getSessionDirectoryOverride(cwd?: string): string | undefined {
  const environment = process.env[ENV_SESSION_DIR];
  if (environment) return resolve(expandTildePath(environment));
  const settings = SettingsManager.create(cwd ?? process.cwd(), getAgentDir(), { projectTrusted: cwd !== undefined });
  const configured = cwd === undefined ? settings.getGlobalSettings().sessionDir : settings.getSessionDir();
  return configured ? resolve(cwd ?? process.cwd(), expandTildePath(configured)) : undefined;
}

export function getSessionCatalogueRoot(): string {
  return getSessionDirectoryOverride() ?? join(getAgentDir(), "sessions");
}
