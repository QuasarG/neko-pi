import type { AgentMessage, ExtensionUiRequest, ToolCallContent } from "./types";

export interface AskUserQuestionView {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  background: boolean;
  multiSelect: boolean;
}

export function askUserQuestionView(input: ToolCallContent["input"]): AskUserQuestionView | null {
  if (typeof input.question !== "string" || !Array.isArray(input.options)) return null;
  const options = input.options.flatMap((option: unknown) => {
    if (!option || typeof option !== "object" || !("label" in option) || typeof option.label !== "string") return [];
    const description = "description" in option && typeof option.description === "string" ? option.description.trim() : undefined;
    return [{ label: option.label.trim(), description }];
  }).filter((option, index, rows) => option.label && rows.findIndex((row) => row.label.toLowerCase() === option.label.toLowerCase()) === index);
  return {
    question: input.question.trim(),
    header: typeof input.header === "string" ? input.header.trim().slice(0, 40) : undefined,
    options,
    background: input.background === true,
    multiSelect: input.multi_select === true,
  };
}

export function matchAskUserQuestion(request: ExtensionUiRequest | null, messages: AgentMessage[], streamingMessage?: Partial<AgentMessage> | null): AskUserQuestionView | null {
  if (request?.method !== "select") return null;
  const candidates = streamingMessage ? [...messages, streamingMessage] : messages;
  for (let index = candidates.length - 1; index >= 0; index--) {
    const message = candidates[index];
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "toolCall" || block.toolName !== "ask_user") continue;
      const question = askUserQuestionView(block.input);
      if (!question) continue;
      const title = question.header ? `${question.header}: ${question.question}` : question.question;
      if (title === request.title && question.options.length === request.options.length && question.options.every((option, index) => option.label === request.options[index])) return question;
    }
  }
  return null;
}

/** What one option click does to the selection: multi toggles the label, single replaces it. */
export function toggleAskUserOption(multiSelect: boolean, selected: string[], label: string): string[] {
  if (!multiSelect) return [label];
  return selected.includes(label) ? selected.filter((item) => item !== label) : [...selected, label];
}

/** The answer Submit would send for this selection, or null while nothing can submit. */
export function askUserSubmitPayload(question: Pick<AskUserQuestionView, "options" | "multiSelect">, selected: string[], freeText: string): { value: string } | { values: string[] } | null {
  const text = freeText.trim();
  if (text) return { value: text };
  // Offered order, so the model reads the labels in the order it offered them.
  const picked = question.options.filter((option) => selected.includes(option.label)).map((option) => option.label);
  if (picked.length === 0) return null;
  return question.multiSelect ? { values: picked } : { value: picked[0] };
}
