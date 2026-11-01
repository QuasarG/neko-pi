"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useDelayedUnmount } from "@/hooks/useDelayedUnmount";
import { askUserQuestionView } from "@/lib/ask-user-view";
import { copyText } from "@/lib/clipboard";
import { isToolCallExpanded, setToolCallExpanded } from "@/lib/tool-call-expansion";
import type { ToolCallContent, ToolResultMessage } from "@/lib/types";
import { MarkdownBody } from "./MarkdownBody";
import { QueuedSummaryText } from "./QueuedSummaryText";
import { CheckIcon, ChevronRightIcon, CopyIcon, toolIconFor } from "./tool-icons";

/** §2.5 verbatim: ZCode's TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS — a closing
 * detail stays mounted a little past the fold so the height animation can
 * finish before the content unmounts. R47: the content clock is 240ms, so
 * the window clears it with a frame to spare. */
export const TOOL_COLLAPSE_UNMOUNT_DELAY_MS = 260;

/** A tool name's lucide glyph: 16px, lucide's default stroke 2 (§2.7). */
export function ToolGlyph({ name }: { name: string }) {
  const Icon = toolIconFor(name);
  return <Icon size={16} className="tool-glyph" />;
}

/**
 * The failure state word (§2.4): dotted underline + a hover/focus tooltip
 * carrying the error text and a copy affordance. ZCode's rows never swap the
 * row color for a status; the word is the only marker, the tooltip the only
 * place the error itself shows. A span (never a real button): it sits inside
 * the summary row's button.
 */
export function ToolErrorStatus({ errorText }: { errorText: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    copyText(errorText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <span className="tool-error" tabIndex={0} aria-label={t("chat.toolStatus.failed")} title={t("chat.toolStatus.failed")}>
      <span className="tool-error-word">{t("chat.toolStatus.failed")}</span>
      <span className="tool-error-popover" role="tooltip">
        <span className="tool-error-text">{errorText}</span>
        <span
          role="button"
          tabIndex={-1}
          className="tool-error-copy"
          aria-label={t("i18n.copy")}
          title={t("i18n.copy")}
          onClick={(event) => { event.stopPropagation(); copy(); }}
        >
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        </span>
      </span>
    </span>
  );
}

export function ConversationTool({ block, result }: { block: ToolCallContent; result?: ToolResultMessage }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() => isToolCallExpanded(block.toolCallId));
  // §2.5: the closing detail stays mounted one short window (past the
  // 180ms fold) so it finishes instead of vanishing.
  const detailRendered = useDelayedUnmount(expanded, TOOL_COLLAPSE_UNMOUNT_DELAY_MS);
  const question = block.toolName === "ask_user" ? askUserQuestionView(block.input) : null;
  const items = block.toolName === "todo_write" && Array.isArray(block.input.items) ? block.input.items.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("content" in item) || typeof item.content !== "string") return [];
    return [{ content: item.content, status: "status" in item && typeof item.status === "string" ? item.status : "pending" }];
  }) : [];
  const goalStatus = block.toolName === "goal_update" && typeof block.input.status === "string" ? block.input.status : null;
  const goalStatusLabel = goalStatus ? t(goalStatus === "completed" ? "chat.goalCompleted" : "chat.goalFailed") : null;
  const goalReason = block.toolName === "goal_update" && typeof block.input.reason === "string" ? block.input.reason : "";
  const label = t(block.toolName === "ask_user" ? "chat.questionTool" : block.toolName === "goal_update" ? "chat.goalTool" : "chat.todoTool");
  const resultText = result?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const pending = !result;
  // §2.4: the row never trades color for a state — a failure shows the status
  // word with its tooltip, and the result text carries nothing else.
  const errorText = result?.isError ? resultText : null;
  // The collapsed row always says something: a goal outcome with no reason
  // falls back to its status word, a plan with no active step to its first
  // pending one, or to an all-done word when every item is complete.
  const activeItem = items.find((item) => item.status === "in_progress") ?? items.find((item) => item.status === "pending");
  const allDone = items.length > 0 && items.every((item) => item.status === "completed");
  const summary = question?.question ?? (goalReason || goalStatusLabel || (activeItem?.content ?? (allDone ? t("chat.todoAllDone") : "")));
  return (
    <div className="conversation-tool">
      <button type="button" className="tool-summary" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); setToolCallExpanded(block.toolCallId, !expanded); }}>
        <span className="tool-glyph-slot"><ToolGlyph name={block.toolName} /></span>
        <span className={`tool-kind${pending ? " animated-gradient-text" : ""}`}>{label}</span>
        {/* The specials consume the roll primitive like ZCode's todo.tsx:144 /
            goal.tsx:196 (QueuedSummaryContent): the summary text rolls when it
            changes while collapsed — a todo stepping on, a goal outcome landing. */}
        <QueuedSummaryText
          contentKey={`${block.toolCallId}:${summary}`}
          enabled={!expanded}
          className="tool-summary-text"
          text={summary}
        />
        {items.length > 0 && <span className="tool-status">{items.filter((item) => item.status === "completed").length}/{items.length}</span>}
        {goalStatusLabel && <span className="tool-status" data-goal-status={goalStatus}>{goalStatusLabel}</span>}
        {errorText && <ToolErrorStatus errorText={errorText} />}
        <ChevronRightIcon size={16} className="tool-chevron" />
      </button>
      {detailRendered && <div className="tool-detail pi-disclose" data-open={expanded} inert={!expanded || undefined}><div className="pi-disclose-body">
        {items.length > 0 ? <ul className="tool-checklist">{items.map((item, index) => <li key={index} data-status={item.status}><span aria-hidden="true">{item.status === "completed" ? "✓" : item.status === "in_progress" ? "▸" : "○"}</span>{item.content}</li>)}</ul>
          : <>{question && <p className="tool-question-text">{question.question}</p>}{goalStatus && (
            <div className="tool-goal-detail">
              <span className="tool-goal-state" data-goal-status={goalStatus}>{goalStatusLabel}</span>
              {goalReason && <span className="tool-goal-reason">{goalReason}</span>}
            </div>
          )}{resultText && <MarkdownBody>{resultText}</MarkdownBody>}</>}
      </div></div>}
    </div>
  );
}
