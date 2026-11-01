/**
 * Tool-name predicates shared by the chat views.
 *
 * Pi's built-in names are plain `write` / `edit`, but MCP servers expose the
 * same operations under prefixed or namespaced names, so each predicate also
 * accepts the common decorated forms.
 */

/** Pi's built-in coding tools that never change a file; the Explore and Plan subagent profiles run on them. */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export function isWriteToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" ||
    name.startsWith("write_") ||
    name.endsWith(".write") ||
    name.endsWith("_write");
}

export function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}

/** Codex-style patch tools (e.g. the pi-apply-patch extension). */
export function isApplyPatchToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "apply_patch" ||
    name.startsWith("apply_patch_") ||
    name.endsWith(".apply_patch") ||
    name.endsWith("_apply_patch");
}

/** Delete operations (§2.8): their own kind word, never a folded-in Edit. */
export function isDeleteToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "delete" ||
    name.startsWith("delete_") ||
    name.endsWith(".delete") ||
    name.endsWith("_delete");
}
