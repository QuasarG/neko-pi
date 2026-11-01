const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const SHELL_TOOLS = new Set(["bash", "powershell"]);

export function isPowerShellToolEnabled(
  defaultTools: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32"
    && defaultTools?.includes("powershell") === true
    && !defaultTools.includes("bash");
}

export function replaceShellTool(
  toolNames: readonly string[],
  usePowerShell: boolean,
): string[] {
  const shell = usePowerShell ? "powershell" : "bash";
  const result: string[] = [];
  for (const name of toolNames) {
    const next = SHELL_TOOLS.has(name) ? shell : name;
    if (!result.includes(next)) result.push(next);
  }
  return result;
}

export function resolveShellTools(
  toolNames: readonly string[],
  defaultTools: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return replaceShellTool(toolNames, isPowerShellToolEnabled(defaultTools, platform));
}

function isToolModifier(entry: string): boolean {
  return entry.startsWith("+") || entry.startsWith("-");
}

/**
 * The tools a `defaultTools` list selects, by pi's rule (0.99): plain names replace the
 * defaults, then each `+name` adds and each `-name` removes a tool, in list order.
 */
export function resolveDefaultToolEntries(entries: readonly string[]): string[] {
  const plain = entries.filter((entry) => !isToolModifier(entry));
  const tools = plain.length > 0 || entries.length === 0 ? plain : [...DEFAULT_TOOLS];
  for (const entry of entries) {
    if (!isToolModifier(entry)) continue;
    const name = entry.slice(1);
    const index = tools.indexOf(name);
    if (entry.startsWith("+") && index === -1 && name) tools.push(name);
    else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
  }
  return tools;
}

