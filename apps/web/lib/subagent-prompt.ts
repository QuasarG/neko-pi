export interface SubagentPromptPlan {
  chatOnly: boolean;
  appendSystemPrompt: string[];
  delegatedTask: string;
  exactSystemPrompt?: string;
}

/**
 * R46/R49 (user order): a delegated child works under the harness identity
 * only — no persona, no other session's memory. The working language is
 * enforced at the source: the Agent tool tells the parent to write prompts in
 * English, so the task the child reads already is.
 */
export const ISOLATION_ADDENDUM_TEXT = [
  "You are a delegated subagent, not the user's assistant.",
  "You have no persona and no memory beyond this session: rely on the task, your tools and the files you read — never on who the delegating assistant is.",
].join("\n");

export function buildSubagentPromptPlan(options: {
  profileSystemPrompt: string;
  tools: readonly string[];
  loadSkills?: boolean;
  loadExtensions?: boolean;
  promptMode?: "replace" | "append";
  task: string;
  inheritedParentContext?: string;
}): SubagentPromptPlan {
  const chatOnly = options.tools.length === 0 && !options.loadSkills && !options.loadExtensions;
  const replacePrompt = options.promptMode === "replace";
  const appendSystemPrompt = [options.profileSystemPrompt, ISOLATION_ADDENDUM_TEXT];
  if (options.inheritedParentContext && !chatOnly) {
    appendSystemPrompt.push(options.inheritedParentContext);
  }
  // R49 (user order): the English constraint lives on the PARENT — the Agent
  // tool tells it to write prompts in English — not as a forced reminder
  // appended to whatever language the task arrived in.
  const task = options.task;
  return {
    chatOnly,
    appendSystemPrompt,
    delegatedTask: options.inheritedParentContext && chatOnly
      ? `${task}\n\n${options.inheritedParentContext}`
      : task,
    ...(chatOnly || replacePrompt
      ? { exactSystemPrompt: [options.profileSystemPrompt, ISOLATION_ADDENDUM_TEXT].join("\n\n") }
      : {}),
  };
}
