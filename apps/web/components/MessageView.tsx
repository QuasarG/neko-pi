"use client";

import { Fragment, memo, useState, useRef, useEffect, useLayoutEffect, useMemo, type CSSProperties } from "react";
import { parseInjectedContext, type InjectedContextParts } from "@earendil-works/pi-coding-agent/injected-context";
import { InjectedContextChips } from "./InjectedContextButton";
import { getFileIcon } from "./FileIcons";
import { ToolCallGroupCard, countToolCallRun, toolCallFamily, type ToolCallFamily } from "./ToolCallGroupCard";
import { MarkdownBody } from "./MarkdownBody";
import { MessageEditor } from "./MessageEditor";
import { ConversationTool, ToolErrorStatus, ToolGlyph, TOOL_COLLAPSE_UNMOUNT_DELAY_MS } from "./ConversationTool";
import { QueuedSummaryText } from "./QueuedSummaryText";
import { ImagePreview } from "./ImagePreview";
import { ThinkingIcon } from "./ThinkingIcon";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { getAssistantErrorMessage, getThinkingPreview, hasAssistantAnswer, isAssistantTruncated, isEmptyThinkingBlock, splitThinkingPieces } from "@/lib/message-display";
import { formatTurnDuration } from "@/lib/turn-duration";
import { streamRateKey, streamRateStart, streamTokensPerSecond, type StreamRateStart } from "@/lib/stream-token-rate";
import { diffGapLabel, parseUnifiedPatch, unifiedDiffLines, type SplitDiffCell, type SplitDiffFile, type SplitDiffGap, type UnifiedDiffLine } from "@/lib/patch";
import { applyPatchPreviewToFiles, applyPatchResultHasFailures, extractApplyPatchPaths, getApplyPatchInputText, parseApplyPatchInput } from "@/lib/apply-patch";
import { isApplyPatchToolName, isDeleteToolName, isEditToolName, isWriteToolName } from "@/lib/tool-names";
import { isToolCallExpanded, setToolCallExpanded } from "@/lib/tool-call-expansion";
import { isThinkingExpandedByDefault, THINKING_EXPANDED_EVENT } from "@/lib/thinking-expansion-preference";
import { useDelayedUnmount } from "@/hooks/useDelayedUnmount";
import { TurnWrittenFiles } from "./TurnWrittenFiles";
import type { WrittenFile } from "@/lib/turn-written-files";
import { skillExpansionContent, skillExpansionToCommand } from "@/lib/slash-display";
import type { SubagentToolDetails } from "@/lib/subagent-extension";
import { CODEMODE_TOOL_NAME, codemodeCalls, codemodeScript, codemodeScriptPreview, stripCodemodeHeader } from "@/lib/codemode-view";
import { CodemodeCallList } from "./CodemodeToolView";
import { BotIcon, ChevronRightIcon , SquareTerminalIcon , GoalIcon} from "./tool-icons";
import { toolFieldsOfInput, type ToolField } from "@/lib/tool-fields";
import { parseStreamingJson } from "@earendil-works/pi-ai/utils/json-parse";
import { mcpToolLabel, prettyMcpResultText } from "@/lib/mcp-tool-display";
import { formatNoticeTokens, getTranscriptNotices } from "@/lib/transcript-notices";
import { TRANSCRIPT_NOTICE_WARNING_COLOR, transcriptNoticeText } from "@/components/TranscriptNotices";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  BashExecutionMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";

// CJK chars ~1 token each (GLM/DeepSeek/GPT-o200k); other chars ~4 chars/token.
const CJK_PATTERN = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}\uac00-\ud7af]/u;
export function estimateTokens(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) cjk++;
    else rest++;
  }
  return cjk + rest / 4;
}

export interface TokenEstimateCacheEntry {
  text: string;
  tokens: number;
}

/** The text the streaming token estimate counts for one block. */
export function getTokenEstimateText(block: AssistantContentBlock): string | null {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return block.thinking;
  if (block.type === "toolCall") return block.rawInput ?? JSON.stringify(block.input ?? {}) ?? "";
  return null;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

export function estimateUpdatedTokens(previous: TokenEstimateCacheEntry | undefined, text: string): number {
  if (!previous || !text.startsWith(previous.text)) return estimateTokens(text);

  let baseTokens = previous.tokens;
  let suffixStart = previous.text.length;
  // A streamed delta can complete a surrogate pair that was counted as two
  // non-CJK code points in the previous update.
  if (
    suffixStart > 0
    && suffixStart < text.length
    && isHighSurrogate(previous.text.charCodeAt(suffixStart - 1))
    && isLowSurrogate(text.charCodeAt(suffixStart))
  ) {
    baseTokens -= 1 / 4;
    suffixStart--;
  }
  return baseTokens + estimateTokens(text.slice(suffixStart));
}

/** The run's token estimate, counting what each block holds now. */
export function estimateStreamedTokens(
  items: ReadonlyArray<{ block: AssistantContentBlock; originalIndex: number }>,
  previous: Map<number, TokenEstimateCacheEntry>,
): { total: number; cache: Map<number, TokenEstimateCacheEntry> } {
  const cache = new Map<number, TokenEstimateCacheEntry>();
  let total = 0;
  for (const { block, originalIndex } of items) {
    const text = getTokenEstimateText(block);
    if (text === null) continue;
    const tokens = estimateUpdatedTokens(previous.get(originalIndex), text);
    cache.set(originalIndex, { text, tokens });
    total += tokens;
  }
  return { total, cache };
}

const MAX_THINKING_CACHE_ENTRIES = 100;
const thinkingContentCache = new Map<string, Promise<string>>();

// Messages larger than this skip markdown rendering entirely. react-markdown +
// KaTeX + syntax highlighting on multi-hundred-KB payloads (e.g. pasted HAR or
// log dumps) freezes the browser main thread.
const MAX_MARKDOWN_CHARS = 100_000;

function formatMessageBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

/**
 * MarkdownBody with an oversized-content guard: huge messages render as a
 * click-to-reveal plain-text <pre> instead of running the markdown pipeline.
 */
function SafeMarkdownBody({ children, className, ...props }: React.ComponentProps<typeof MarkdownBody>) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);

  if (children.length <= MAX_MARKDOWN_CHARS) {
    return <MarkdownBody className={className} {...props}>{children}</MarkdownBody>;
  }
  if (!showRaw) {
    return (
      <button
        onClick={() => setShowRaw(true)}
        style={{
          display: "block",
          width: "100%",
          margin: "4px 0",
          padding: "7px 10px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))",
          textAlign: "left",
        }}
      >
        ⚠ {t("i18n.largeMessageReveal", { size: formatMessageBytes(children.length) })}
      </button>
    );
  }
  return (
    <div className={className} style={{ maxHeight: 420, overflow: "auto", fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))", lineHeight: 1.5 }}>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
        }}
      >
        {children}
      </pre>
    </div>
  );
}

// Cap the user "sent" bubble's height so an abnormally long message does not
// push the conversation off screen; overflow scrolls inside the bubble.

function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number): Promise<string> {
  const key = `${sessionId}:${entryId}:${blockIndex}`;
  const cached = thinkingContentCache.get(key);
  if (cached) {
    thinkingContentCache.delete(key);
    thinkingContentCache.set(key, cached);
    return cached;
  }

  const request = fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`,
  ).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { thinking?: unknown };
    if (typeof data.thinking !== "string") throw new Error("Invalid thinking response");
    return data.thinking;
  }).catch((error) => {
    thinkingContentCache.delete(key);
    throw error;
  });

  thinkingContentCache.set(key, request);
  if (thinkingContentCache.size > MAX_THINKING_CACHE_ENTRIES) {
    const oldestKey = thinkingContentCache.keys().next().value;
    if (oldestKey) thinkingContentCache.delete(oldestKey);
  }
  return request;
}

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onEditContent?: (message: UserMessage, entryId: string) => void;
  onSubmitEdit?: (message: UserMessage, entryId: string, rawText: string) => Promise<void>;
  onCancelEdit?: () => void;
  isEditing?: boolean;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  /**
   * Files this turn wrote, derived by the caller from the whole turn's
   * successful write/edit tool calls. ChatWindow computes this because the
   * saved-message path splits tool calls into their own entries, leaving the
   * final answer text-only.
   */
  writtenFiles?: WrittenFile[];
  /** The whole turn's time, for a final answer with no process details to show it. */
  turnDurationMs?: number;
  /** Assistant actions row (copy/stats/time). ZCode hides it on every segment
   * but the turn's latest (`hideAssistantActions={!item.latest}`); the process
   * fold's intermediate replies render none, so they take no height. */
  showActions?: boolean;
  /** Opens a user message's injected context in the right panel (R26): the
   * bubble carries only the summary button; the detail never renders inline. */
  onOpenInjectedContext?: (payload: { key: string; title: string; parts: InjectedContextParts }) => void;
  onCompact?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  /** Reports the live output rate of a streaming assistant message. */
  onStreamRate?: (rate: number | null) => void;
}

export function getModelDisplayName(
  provider: string,
  responseModel: string,
  modelNames?: Record<string, string>,
): string {
  const normalizedProvider = provider.toLowerCase();
  const normalizedResponse = responseModel.toLowerCase();
  const configured = Object.entries(modelNames ?? {}).flatMap(([key, name]) => {
    const separator = key.indexOf(":");
    return separator > 0 && key.slice(0, separator).toLowerCase() === normalizedProvider
      ? [{ id: key.slice(separator + 1).toLowerCase(), name }]
      : [];
  });
  return configured.find((model) => model.id === normalizedResponse)?.name
    ?? configured.find((model) => normalizedResponse.endsWith(`/${model.id}`))?.name
    ?? Object.entries(modelNames ?? {}).find(([key]) => key.toLowerCase() === normalizedResponse)?.[1]
    ?? `${provider}/${responseModel}`;
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

export function replaceUserMessageText(message: UserMessage, text: string): UserMessage {
  if (typeof message.content === "string") return { ...message, content: text };

  const content: Array<TextContent | ImageContent> = [];
  let replaced = false;
  for (const block of message.content) {
    if (block.type !== "text") {
      content.push(block);
      continue;
    }
    if (!replaced) {
      content.push({ ...block, text });
      replaced = true;
    }
  }
  if (!replaced) content.unshift({ type: "text", text });
  return { ...message, content };
}

function haveSameRelevantToolResults(
  message: AgentMessage,
  previous: Map<string, ToolResultMessage> | undefined,
  next: Map<string, ToolResultMessage> | undefined,
): boolean {
  if (previous === next || message.role !== "assistant") return true;
  for (const block of (message as AssistantMessage).content ?? []) {
    if (block.type === "toolCall" && previous?.get(block.toolCallId) !== next?.get(block.toolCallId)) {
      return false;
    }
  }
  return true;
}

export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, cwd, onOpenFile, onOpenSubagent, entryId, searchBlock, onFork, forking, onEditContent, onSubmitEdit, onCancelEdit, isEditing, showTimestamp, prevTimestamp, sessionId, writtenFiles, turnDurationMs, showActions, onOpenInjectedContext, onCompact, isCompacting, compactError, onStreamRate }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} onEditContent={onEditContent} onSubmitEdit={onSubmitEdit} onCancelEdit={onCancelEdit} isEditing={isEditing} onOpenInjectedContext={onOpenInjectedContext} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} cwd={cwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} sessionId={sessionId} entryId={entryId} searchBlock={searchBlock} writtenFiles={writtenFiles} turnDurationMs={turnDurationMs} showActions={showActions} onCompact={onCompact} isCompacting={isCompacting} compactError={compactError} onStreamRate={onStreamRate} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "compaction") {
      return <CompactionMessageView message={message as CustomMessage} />;
    }
    return <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView message={message as BashExecutionMessage} sessionId={sessionId} />;
  }
  return null;
}, (prev, next) => {
  return prev.message === next.message
    && prev.isStreaming === next.isStreaming
    && haveSameRelevantToolResults(prev.message, prev.toolResults, next.toolResults)
    && prev.modelNames === next.modelNames
    && prev.cwd === next.cwd
    && prev.onOpenFile === next.onOpenFile
    && prev.onOpenSubagent === next.onOpenSubagent
    && prev.entryId === next.entryId
    && prev.searchBlock === next.searchBlock
    && prev.onFork === next.onFork
    && prev.forking === next.forking
    && prev.onEditContent === next.onEditContent
    && prev.onSubmitEdit === next.onSubmitEdit
    && prev.onCancelEdit === next.onCancelEdit
    && prev.isEditing === next.isEditing
    && prev.showTimestamp === next.showTimestamp
    && prev.prevTimestamp === next.prevTimestamp
    && prev.writtenFiles === next.writtenFiles
    && prev.turnDurationMs === next.turnDurationMs
    && prev.showActions === next.showActions
    && prev.sessionId === next.sessionId
    && prev.onCompact === next.onCompact
    && prev.onOpenInjectedContext === next.onOpenInjectedContext
    && prev.isCompacting === next.isCompacting
    && prev.compactError === next.compactError;
});

function UserMessageView({ message, cwd, onOpenFile, entryId, onFork, forking, onEditContent, onSubmitEdit, onCancelEdit, isEditing, onOpenInjectedContext }: {
  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  entryId?: string;
  onOpenInjectedContext?: (payload: { key: string; title: string; parts: InjectedContextParts }) => void;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onEditContent?: (message: UserMessage, entryId: string) => void;
  onSubmitEdit?: (message: UserMessage, entryId: string, rawText: string) => Promise<void>;
  onCancelEdit?: () => void;
  isEditing?: boolean;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Session files can hold `\r\n` or lone `\r` line endings (#680). Chrome renders
  // a lone `\r` as a space even in the pre-wrap command-args and raw-text views.
  // Copy uses this text too; the session file keeps the original endings.
  const deliveredContent = (
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n")
  ).replace(/\r\n?/g, "\n");
  const injections = useMemo(() => parseInjectedContext(deliveredContent), [deliveredContent]);
  const content = injections?.userText ?? deliveredContent;

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  const commandText = skillExpansionToCommand(content);
  const commandSeparator = commandText?.search(/\s/) ?? -1;
  const commandName = commandText
    ? commandSeparator === -1 ? commandText : commandText.slice(0, commandSeparator)
    : "";
  const commandArgs = commandText && commandSeparator !== -1
    ? commandText.slice(commandSeparator + 1)
    : "";

  // R49: chip source — a plain TYPED slash command only. A skill expansion
  // keeps its own compact expandable form (its body is worth the toggle);
  // /goal-style commands have nothing to expand, so they take the chip.
  const slashChipText = !commandText && imageBlocks.length === 0 && content.trim().startsWith("/") ? content.trim() : null;

  // R49 (user order): a sent slash command shows as ZCode's icon + text chip —
  // a skill expansion or a plain typed command alike — never a bare bubble.
  const commandChipNode = !isEditing && slashChipText ? (() => {
    const separator = slashChipText.search(/\s/);
    const name = separator === -1 ? slashChipText : slashChipText.slice(0, separator);
    const args = separator === -1 ? "" : slashChipText.slice(separator + 1);
    // ZCode's mention chip: a per-command icon (goal gets its target, the
    // rest the terminal) before the name (ConversationUserInputContent.tsx).
    const bare = name.slice(1);
    const Icon = bare === "goal" || bare === "target" ? GoalIcon : SquareTerminalIcon;
    return (
      <span className="user-command-chip">
        <Icon size={13} />
        <span className="user-command-chip-name">{name}</span>
        {args && <span className="user-command-chip-args">{args}</span>}
      </span>
    );
  })() : null;

  const canFork = !!entryId && !!onFork;
  const copyTarget = commandText ?? content;
  const editTarget = replaceUserMessageText(message, commandText ?? content);

  const imageBlocksNode = imageBlocks.length > 0 && (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
      {imageBlocks.map((img, i) => {
        // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
        // pi-ai on-disk format uses flat {data, mimeType} — handle both
        const flat = img as unknown as { data?: string; mimeType?: string };
        const src = img.source
          ? img.source.type === "base64"
            ? `data:${img.source.media_type};base64,${img.source.data}`
            : img.source.url ?? ""
          : flat.data
            ? `data:${flat.mimeType};base64,${flat.data}`
            : "";
        return (
          <ImagePreview key={i} src={src}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              style={{ maxWidth: 240, maxHeight: 240, borderRadius: "var(--radius-sm)", objectFit: "contain", display: "block", border: "1px solid color-mix(in srgb, var(--accent) 15%, transparent)" }}
            />
          </ImagePreview>
        );
      })}
    </div>
  );
  const canEdit = !!entryId && !!onEditContent;
  const canCancelEdit = !!isEditing && !!onCancelEdit;

  const copyContent = () => {
    copyText(copyTarget).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      data-message-role="user"
      data-entry-id={entryId}
      style={{ marginBottom: 20, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={`user-message-bubble-wrap${isEditing ? " is-editing" : ""}`} style={{ display: "flex", alignItems: "flex-end", gap: 6, maxWidth: "min(576px, 100%)" }}>
        <div
          data-user-message-bubble
          style={{
            flex: 1,
            minWidth: 0,
            // §4.1 verbatim: borderless bubble on --user-bg, all radii 12px
            // (rounded-xl), px-4/py-3, body size. Editing swaps to the composer
            // chrome; the plain bubble carries no border at all.
            background: isEditing ? "color-mix(in srgb, var(--accent) 14%, var(--user-bg))" : "var(--user-bg)",
            border: isEditing ? "1px solid color-mix(in srgb, var(--accent) 62%, var(--user-bg))" : "none",
            boxShadow: isEditing ? "0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent)" : undefined,
            borderRadius: 12,
            padding: "12px 16px",
            fontSize: "var(--conversation-font-size, 16px)",
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
            // R47 (user order): a user message shows whole — no inner cap, no
            // inner scroll; the conversation column itself is the scroller.
          }}
        >
          {isEditing && onSubmitEdit && onCancelEdit && entryId ? (
            <>
              {imageBlocksNode}
              {/* rawText: the delivered text with its injection blocks, so the
                  resend re-attaches them and only the time is renewed. */}
              <MessageEditor text={commandText ?? content} onCancel={onCancelEdit} onSubmit={(text) => onSubmitEdit(replaceUserMessageText(editTarget, text), entryId, deliveredContent)} />
            </>
          ) : commandChipNode ? (
            commandChipNode
          ) : commandText ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              {imageBlocksNode}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => setExpanded((prev) => !prev)}
                  title={expanded ? t("i18n.collapse") : t("i18n.expand")}
                  aria-expanded={expanded}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0,
                    padding: 0,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--accent)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))",
                    textAlign: "left",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {commandName}
                  </span>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0, opacity: 0.75, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {commandArgs && (
                  <span style={{
                    color: "var(--text)",
                    fontSize: "var(--conversation-font-size, 16px)",
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    minWidth: 0,
                    flex: 1,
                  }}>
                    {commandArgs}
                  </span>
                )}
              </div>
              {expanded && (
                <MarkdownBody className="markdown-user-message" keepLineBreaks cwd={cwd} onOpenFile={onOpenFile}>{skillExpansionContent(content) ?? content}</MarkdownBody>
              )}
            </div>
          ) : (
          <>
          {imageBlocksNode}
          {content && <SafeMarkdownBody className="markdown-user-message" keepLineBreaks cwd={cwd} onOpenFile={onOpenFile}>{content}</SafeMarkdownBody>}
          </>
          )}
        </div>

      </div>

      {/* Bottom row: hover-only actions. ZCode's user bubble carries no
          standing timestamp (R23b); injected context rides here too (R27) —
          per-producer chips that appear with the row and open the detail in
          the right panel, never inline. */}
      {!(isEditing && onSubmitEdit) && (
        <div className={`message-actions-row${hovered || forking || canCancelEdit ? "" : " is-hidden"}`} style={{ justifyContent: "flex-end", marginTop: 3 }}>
          {injections && !isEditing && onOpenInjectedContext && (
            <InjectedContextChips
              parts={injections}
              keySeed={entryId ?? String(message.timestamp ?? "")}
              onOpen={onOpenInjectedContext}
            />
          )}
          <button
            type="button"
            className="message-action"
            onClick={copyContent}
            title={t("i18n.copyMessage")}
            aria-label={t("i18n.copyMessage")}
            style={{ color: copied ? "var(--accent)" : undefined }}
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
          {canEdit && !canCancelEdit && (
            <button
              type="button"
              className="message-action"
              onClick={() => onEditContent!(editTarget, entryId!)}
              title={t("i18n.editFromHereTitle")}
              aria-label={t("i18n.editFromHere")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 10 20 15 15 20" />
                <path d="M4 4v7a4 4 0 0 0 4 4h12" />
              </svg>
            </button>
          )}
          {canCancelEdit && (
            <button
              type="button"
              className="message-action"
              onClick={onCancelEdit}
              title={t("i18n.cancel")}
              aria-label={t("i18n.cancel")}
              style={{ color: "var(--accent)" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
          {canFork && (
            <button
              type="button"
              className="message-action"
              onClick={() => { onFork!(entryId!); }}
              disabled={forking}
              title={forking ? t("i18n.creatingSession") : t("i18n.newSessionTitle")}
              aria-label={forking ? t("i18n.creatingSession") : t("i18n.newSession")}
              style={{ color: forking ? "var(--accent)" : undefined }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  cwd,
  onOpenFile,
  onOpenSubagent,
  showTimestamp,
  prevTimestamp,
  sessionId,
  entryId,
  searchBlock,
  writtenFiles,
  turnDurationMs,
  showActions = true,
  onCompact,
  isCompacting,
  compactError,
  onStreamRate,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  writtenFiles?: WrittenFile[];
  turnDurationMs?: number;
  showActions?: boolean;
  onCompact?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  /** Reports the live output rate while this message streams; null when it stops. */
  onStreamRate?: (rate: number | null) => void;
}) {
  const { t } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const blockItems = useMemo(() => (message.content ?? [])
    .map((block, originalIndex) => ({ block, originalIndex }))
    .filter(({ block }) => !isEmptyThinkingBlock(block, { isStreaming })), [message.content, isStreaming]);
  const blocks = useMemo(() => blockItems.map(({ block }) => block), [blockItems]);
  const providerError = getAssistantErrorMessage(message, { isStreaming });
  const truncated = isAssistantTruncated(message, { isStreaming });
  const unansweredTruncation = truncated && !hasAssistantAnswer(message);
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const blockItemsRef = useRef(blockItems);
  blockItemsRef.current = blockItems;

  // Live output rate for the top-right stats strip (R61). The estimate counts
  // the blocks as they grow; the compositor keys a sample to this message so a
  // new turn starts from zero. Nothing is rendered per message (R23a).
  const streamStartRef = useRef<StreamRateStart | null>(null);
  const rateKeyRef = useRef(streamRateKey(message));
  rateKeyRef.current = streamRateKey(message);
  const tokenEstimateCacheRef = useRef<Map<number, TokenEstimateCacheEntry>>(new Map());
  const estimatedTokens = useMemo(() => {
    if (!isStreaming) {
      tokenEstimateCacheRef.current = new Map();
      return 0;
    }
    const { total, cache } = estimateStreamedTokens(blockItems, tokenEstimateCacheRef.current);
    tokenEstimateCacheRef.current = cache;
    return total;
  }, [blockItems, isStreaming]);
  const estimatedTokensRef = useRef(estimatedTokens);
  estimatedTokensRef.current = estimatedTokens;
  const onStreamRateRef = useRef(onStreamRate);
  onStreamRateRef.current = onStreamRate;
  useEffect(() => () => onStreamRateRef.current?.(null), []);

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration of a completed message: the whole response's generation time, which pi
  // records since 1.1 (`durationMs`, from the request's start). Older messages only have
  // timestamps: the time since the previous message.
  const messageDurationMs = message.role === "assistant" ? recordedDurationMs(message.durationMs) : undefined;
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    const ms = messageDurationMs ?? (message.timestamp && prevTimestamp ? message.timestamp - prevTimestamp : undefined);
    if (ms === undefined) return undefined;
    // §3: Math.ceil with a floor of 1 — a sub-second run still read "1s".
    const secs = Math.max(1, Math.ceil(ms / 1000));
    return secs > 0 ? secs : undefined;
  }, [messageDurationMs, message.timestamp, prevTimestamp]);

  // Tool call durations in milliseconds: the execution time pi records on each result since 1.1,
  // as the pi CLI's "Took" shows it. An older result only has timestamps, the result's minus this
  // message's (when its request started), which counts the model's generation too.
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults) return map;
    for (const [callId, result] of toolResults) {
      const ms = recordedDurationMs(result.durationMs)
        ?? (result.timestamp && message.timestamp ? result.timestamp - message.timestamp : undefined);
      if (ms !== undefined && ms >= TOOL_DURATION_MIN_MS) map.set(callId, ms);
    }
    return map;
  }, [toolResults, message.timestamp]);

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const stats = message.usage ? formatUsage(message.usage) : [];
  if (turnDurationMs !== undefined) {
    if (stats.length > 0) stats.push({ text: "·" });
    const time = formatTurnDuration(turnDurationMs);
    stats.push(formatDurationPart(t("chat.turnDuration", { time }), time));
  }

  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    if (!isStreaming) {
      streamStartRef.current = null;
      onStreamRateRef.current?.(null);
      // Finalise any un-finished thinking block durations on stream end
      const now = new Date().getTime();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.max(1, Math.ceil((now - start) / 1000)));
        }
        return next;
      });
      return;
    }
    const tick = () => {
      const items = blockItemsRef.current;
      const now = Date.now();

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex)) blockStartTimesRef.current.set(originalIndex, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex;
          const nextOriginalIndex = items[i + 1].originalIndex;
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!;
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now;
            next.set(originalIndex, Math.max(1, Math.ceil((nextStart - start) / 1000)));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      // Token rate: samples start with the first counted token and reset when
      // the message (a new turn) changes.
      const tokens = estimatedTokensRef.current;
      if (tokens === 0) return;
      streamStartRef.current ??= streamRateStart(rateKeyRef.current, tokens, now);
      const rate = streamTokensPerSecond(streamStartRef.current, tokens, now);
      if (rate !== null) onStreamRateRef.current?.(rate);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (blocks.length === 0 && !isStreaming && !providerError && !truncated) return null;

  return (
    <div
      data-message-role="assistant"
      data-entry-id={entryId}
      style={{ marginBottom: 20 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* No per-message model label (R23a): ZCode names the model only on
          change markers and in the composer. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Not keyed by the entry id: a message of this run gets one when the file is
            read again, and its blocks keep their state across that read (#1184).
            §4.2: consecutive tool/reasoning rows ride the 16px (gap-4) rhythm.
            Runs of SAME-FAMILY tool calls ≥2 merge into one group card first
            (ZCode executeGroup/changesGroup/exploreGroup): collapsed, N calls
            are one row — the calls read as one continuous run, not N rows. */}
        {buildBlockRuns(blockItems, toolFamilyOf).map(({ runKey, family, blocks: run }) =>
          family && run.length > 1 ? (
            <ToolCallGroupCard key={runKey} family={family} label={t(FAMILY_KIND_KEY[family])} counts={countToolCallRun(family, run.map(({ block }) => (block as ToolCallContent).toolName))} groupKey={`group:${(run[0].block as ToolCallContent).toolCallId}`}>
              {run.map(({ block, originalIndex }) => (
                <BlockView key={originalIndex} block={block} searchTarget={block === searchBlock} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={streamingDurations.get(originalIndex) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} cwd={cwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} sessionId={sessionId} entryId={entryId} blockIndex={originalIndex} />
              ))}
            </ToolCallGroupCard>
          ) : (
            <BlockView key={runKey} block={run[0].block} searchTarget={run[0].block === searchBlock} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={streamingDurations.get(run[0].originalIndex) ?? (run[0].block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} cwd={cwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} sessionId={sessionId} entryId={entryId} blockIndex={run[0].originalIndex} />
          )
        )}
      </div>

      {providerError && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid color-mix(in srgb, var(--feedback-danger) 30%, transparent)",
            borderRadius: "var(--radius-sm)",
            background: "color-mix(in srgb, var(--feedback-danger) 7%, transparent)",
            color: "var(--feedback-danger)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          Error: {providerError}
        </div>
      )}

      {truncated && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 || providerError ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid color-mix(in srgb, var(--feedback-warning) 30%, transparent)",
            borderRadius: "var(--radius-sm)",
            background: "color-mix(in srgb, var(--feedback-warning) 7%, transparent)",
            color: "color-mix(in srgb, var(--feedback-warning) 82%, #000)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {t(unansweredTruncation ? "chat.truncatedWithoutAnswer" : "chat.truncatedByOutputLimit")}
          {unansweredTruncation && onCompact && (
            <button
              type="button"
              onClick={onCompact}
              disabled={isCompacting}
              style={{
                display: "block",
                marginTop: 8,
                padding: "3px 8px",
                border: "1px solid currentColor",
                borderRadius: 5,
                background: "transparent",
                color: "inherit",
                cursor: isCompacting ? "default" : "pointer",
                font: "inherit",
              }}
            >
              {t(isCompacting ? "chat.compacting" : "chat.compactContext")}
            </button>
          )}
          {unansweredTruncation && compactError && (
            <div style={{ marginTop: 8, color: "var(--feedback-danger)", whiteSpace: "pre-wrap" }}>{compactError}</div>
          )}
        </div>
      )}

      {writtenFiles && writtenFiles.length > 0 && (
        <TurnWrittenFiles files={writtenFiles} onOpenFile={onOpenFile} />
      )}

      {/* ZCode's MessageActions row (ConversationRowView.tsx:1745-1815): a
          hover-only strip — copy, pi's usage counts, then the message time
          last, all at caption size in the subtlest ink. Nothing here is
          standing: no model label, no always-visible usage/time (R23b).
          Process-fold segments pass showActions={false} (ZCode's
          hideAssistantActions for every non-latest segment), and an empty
          row renders nothing at all so it takes no height. */}
      {showActions && !isStreaming && (textContent || time || stats.length > 0) && (
        <div className={`message-actions-row${hovered ? "" : " is-hidden"}`} style={{ marginTop: 4 }}>
          {textContent && (
            <button
              type="button"
              className="message-action"
              onClick={copyContent}
              title={t("i18n.copyMessage")}
              aria-label={t("i18n.copyMessage")}
              style={{ color: copied ? "var(--accent)" : undefined }}
            >
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          )}
          {stats.length > 0 && (
            // One item per count: a single space at 11px ran them together. The
            // spaces stay in the text for copying; the flex gap draws the room.
            <div className="message-meta" style={{ display: "flex", flexWrap: "wrap", columnGap: 7 }}>
              {stats.map((part, index) => (
                <Fragment key={index}>{index > 0 && " "}<UsagePart part={part} /></Fragment>
              ))}
            </div>
          )}
          {time && <span className="message-meta">{time}</span>}
        </div>
      )}
    </div>
  );
}


/** ZCode's family vocabulary for merged call runs (§2.8 kind words). The
 *  changes family reads as 更改 (chat.toolGroup.changesLabel), ZCode's
 *  ChangesGroup title — the per-call 编辑 kind stays on the children. */
const FAMILY_KIND_KEY = {
  terminal: "chat.toolCall.kind.terminal",
  changes: "chat.toolGroup.changesLabel",
  explore: "chat.toolGroup.explore",
} as const;

type FamilyProbe = (name: string) => ToolCallFamily | null;
const toolFamilyOf: FamilyProbe = toolCallFamily;

/** Group consecutive same-family tool-call blocks into mergeable runs. */
function buildBlockRuns(blockItems: Array<{ block: AssistantContentBlock; originalIndex: number }>, familyOf: FamilyProbe): Array<{ runKey: string; family: ToolCallFamily | null; blocks: Array<{ block: AssistantContentBlock; originalIndex: number }> }> {
  const runs: Array<{ runKey: string; family: ToolCallFamily | null; blocks: Array<{ block: AssistantContentBlock; originalIndex: number }> }> = [];
  for (const item of blockItems) {
    const family = item.block.type === "toolCall" ? familyOf((item.block as ToolCallContent).toolName) : null;
    const last = runs.at(-1);
    if (family !== null && last && last.family === family) {
      last.blocks.push(item);
      continue;
    }
    runs.push({ runKey: `b${item.originalIndex}`, family, blocks: [item] });
  }
  return runs;
}

function BlockView({ block, searchTarget, toolResults, isStreaming, streamingDuration, toolCallDurations, cwd, onOpenFile, onOpenSubagent, sessionId, entryId, blockIndex }: { block: AssistantContentBlock; searchTarget?: boolean; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; cwd?: string; onOpenFile?: (filePath: string, page?: number) => void; onOpenSubagent?: (sessionId: string, label: string) => void; sessionId?: string; entryId?: string; blockIndex: number }) {
  if (block.type === "text") {
    return <div data-message-text data-search-target={searchTarget || undefined}><TextBlock block={block as TextContent} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} /></div>;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} streaming={isStreaming} sessionId={sessionId} entryId={entryId} blockIndex={blockIndex} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} duration={duration} onOpenSubagent={onOpenSubagent} />;
  }
  return null;
}

function TextBlock({ block, isStreaming, cwd, onOpenFile }: { block: TextContent; isStreaming?: boolean; cwd?: string; onOpenFile?: (filePath: string, page?: number) => void }) {
  return <SafeMarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</SafeMarkdownBody>;
}

// A model looping in its thinking can write megabytes. As one text node, every
// streamed chunk laid all of it out again (the prompt anchor reads layout after
// each commit). As pieces, only the last one changes. Thinking that fits one
// piece stays one text node.
function ThinkingText({ text }: { text: string }) {
  const pieces = useMemo(() => splitThinkingPieces(text), [text]);
  if (pieces.length === 1) return text;
  // No memo: React already skips a div whose text is unchanged, and a memo
  // bailout keeps the old props, each a slice pinning the whole thinking of
  // its chunk (995 MB retained streaming 2M Chinese characters).
  return pieces.map((piece, index) => <div key={index}>{piece.text}</div>);
}

export function ThinkingBlock({ block, duration, streaming, sessionId, entryId, blockIndex }: {
  block: ThinkingContent;
  duration?: number;
  streaming?: boolean;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(isThinkingExpandedByDefault);
  // A03/§2.5: the body folds closed over ZCode's 300ms window instead of
  // unmounting; the row does not reflow mid-motion.
  const bodyRendered = useDelayedUnmount(expanded, TOOL_COLLAPSE_UNMOUNT_DELAY_MS);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The block outlives a change of entry id (a message of this run gets its id
  // when the file is read again, #1184): what was loaded for another entry goes.
  const loadKey = `${sessionId}:${entryId}:${blockIndex}`;
  const [loadedKey, setLoadedKey] = useState(loadKey);
  if (loadedKey !== loadKey) {
    setLoadedKey(loadKey);
    setContent(null);
    setLoading(false);
    setError(null);
  }
  const tRef = useRef(t);
  tRef.current = t;
  const preview = getThinkingPreview(block.thinking);
  // §3: while streaming, the collapsed row rolls the reasoning's last
  // non-empty line beside the label; a finished block shows only its word
  // and, when known, its seconds.
  const lastLine = streaming
    ? block.thinking.split("\n").map((line) => line.trim()).findLast((line) => line.length > 0) ?? null
    : null;
  // §3 (reasoning.tsx:329-337): the sweep runs ONLY while streaming AND
  // collapsed; expanded, the label is the completed shape — "Thought · Xs" —
  // with a 1s ticking timer that counts only while expanded. A streaming
  // block mounts when it first appears, so its mount time is its start.
  const startedAtRef = useRef<number>(Date.now());
  const [liveSeconds, setLiveSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!streaming || !expanded) {
      setLiveSeconds((current) => (current === null ? current : null));
      return;
    }
    const tick = () => setLiveSeconds(Math.max(1, Math.ceil((Date.now() - startedAtRef.current) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [streaming, expanded]);
  const expandedLiveSeconds = streaming && expanded
    ? (liveSeconds ?? Math.max(1, Math.ceil((Date.now() - startedAtRef.current) / 1000)))
    : null;
  const secondsLabel = expandedLiveSeconds !== null
    ? `${expandedLiveSeconds}s`
    : duration !== undefined ? `${duration}s` : t("chat.reasoning.fewSeconds");
  // The streaming line keeps its tail in view as the text grows (§3).
  const liveLineRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = liveLineRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [lastLine]);

  // Keep already-mounted blocks in sync when the preference changes.
  useEffect(() => {
    const onChange = () => setExpanded(isThinkingExpandedByDefault());
    window.addEventListener(THINKING_EXPANDED_EVENT, onChange);
    return () => window.removeEventListener(THINKING_EXPANDED_EVENT, onChange);
  }, []);

  // Load deferred history content whenever the block is expanded.
  // loadThinkingContent() memoizes in-flight promises and drops failed ones
  // from its cache, so re-running this effect is cheap and a failed load can
  // be retried by collapsing and expanding the block again.
  useEffect(() => {
    if (!expanded || !block.deferred || content !== null) return;
    if (!sessionId || !entryId) {
      setError(tRef.current("i18n.thinkingUnavailable"));
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadThinkingContent(sessionId, entryId, blockIndex)
      .then((value) => {
        if (!cancelled) {
          setContent(value);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, block.deferred, content, sessionId, entryId, blockIndex]);

  return (
    <div className="conversation-thinking">
      <button
        type="button"
        className="tool-summary"
        aria-expanded={expanded}
        aria-label={`${t("i18n.thinking")}${preview ? `: ${preview}` : ""}`}
        onClick={() => setExpanded((v) => !v)}
      >
        <ThinkingIcon />
        {streaming && !expanded
          ? <span className="tool-kind animated-gradient-text">{t("chat.reasoning.thinking")}</span>
          : <span className="tool-kind">
              {t("chat.reasoning.thought")}
              {/* §3: while streaming+expanded the seconds tick live; done, an
                  unknown duration falls back to "a few seconds" — never an
                  empty tail after the separator. */}
              <span className="reasoning-duration"> · {secondsLabel}</span>
            </span>}
        {/* §3: the rolling last line is the collapsed row's preview — expanded,
            the body below is the live text and the label stands alone. */}
        {lastLine !== null && !expanded && <span ref={liveLineRef} className="reasoning-live-line">· {lastLine}</span>}
        <ChevronRightIcon size={16} className="tool-chevron" />
      </button>
      {bodyRendered && (
        <div className="reasoning-detail pi-disclose" data-open={expanded} inert={!expanded || undefined}>
          <div
            className="pi-disclose-body"
            style={{
              color: error ? "var(--feedback-danger)" : "var(--text-dim)",
            }}
          >
            <div className="thinking-rail" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {loading ? <span className="pi-loading-shimmer">{t("i18n.loadingThinking")}</span> : error ?? <ThinkingText text={(block.deferred ? content : block.thinking) ?? ""} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function isSubagentToolDetails(value: unknown): value is SubagentToolDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<SubagentToolDetails>;
  return details.kind === "pi-web-subagent" && typeof details.sessionId === "string";
}

/** A duration pi recorded on a message, or undefined when there is none to trust. */
function recordedDurationMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Below this a tool card shows no time: it would read 0.0s on every quick read or search. */
const TOOL_DURATION_MIN_MS = 100;

/** A tool's run time as the pi CLI's "Took" writes it: 2.4s, then 3m 5s, then 1h 2m 5s. */
export function formatToolDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** §2.8: the localized kind words per tool family — running vs done
 * vocabulary, the message ids ZCode's renderers use. Codemode keeps its
 * registered name (ZCode's node-repl rows carry no kind word). */
export function toolKindMessageIds(toolName: string): { running: string; done: string } | null {
  const name = toolName.toLowerCase();
  if (name === "read") return { running: "chat.toolCall.read.reading", done: "chat.toolCall.kind.read" };
  if (name === "grep" || name === "find" || name === "ls" || name === "glob" || name === "search") {
    return { running: "chat.toolCall.search.searching", done: "chat.toolCall.kind.search" };
  }
  if (isWriteToolName(toolName)) return { running: "chat.toolCall.edit.writing", done: "chat.toolCall.kind.write" };
  // Deletes carry their own vocabulary (§2.8 getEditKindLabelMessageId) instead
  // of collapsing into Edit; the check sits before the edit family so a
  // decorated delete name is never relabelled by a broader edit match.
  if (isDeleteToolName(toolName)) {
    return { running: "chat.toolCall.edit.deleting", done: "chat.toolCall.kind.delete" };
  }
  if (isEditToolName(toolName) || isApplyPatchToolName(toolName)) {
    return { running: "chat.toolCall.edit.editing", done: "chat.toolCall.kind.edit" };
  }
  if (name === "bash" || name.startsWith("bash ") || name.startsWith("bash_") || name === "execute") {
    return { running: "chat.toolCall.execute.running", done: "chat.toolCall.kind.terminal" };
  }
  if (name === "agent" || name === "task" || name === "subagent") {
    return { running: "chat.toolCall.agent.running", done: "chat.toolCall.kind.agent" };
  }
  return null;
}

function ToolCallBlock({ block, result, duration, onOpenSubagent }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number; onOpenSubagent?: (sessionId: string, label: string) => void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() => isToolCallExpanded(block.toolCallId));
  // A03 + §2.5: the detail wrappers stay mounted ZCode's 300ms window after a
  // collapse, so the height animation finishes instead of unmounting to a
  // blank flash; data-open carries the fold state to CSS.
  const detailsRendered = useDelayedUnmount(expanded, TOOL_COLLAPSE_UNMOUNT_DELAY_MS);
  const toggleExpanded = () => {
    const next = !expanded;
    setToolCallExpanded(block.toolCallId, next);
    setExpanded(next);
  };
  const writtenFileText = getWrittenFileText(block);
  const inputStr = writtenFileText ?? getToolCallInputText(block);
  const isStreamingInput = block.rawInput !== undefined;
  const isEditTool = isEditToolName(block.toolName);
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;
  // A call that names no file (an anchor-addressed edit) is labelled with the
  // one file its result's patch changed, the path its TUI renderer shows.
  const resultDiffText = resultDiff?.text;
  const resultPatchPath = useMemo(() => singlePatchPath(resultDiffText), [resultDiffText]);
  const patchFiles = getApplyPatchFiles(block, result);
  const patchLabel = isApplyPatchToolName(block.toolName)
    ? summarizeApplyPatchInput(block)
    : null;
  // A script and the calls it made, instead of the input JSON. Streamed input is
  // still incomplete JSON and keeps the generic view.
  const codemodeCode = block.toolName === CODEMODE_TOOL_NAME && !isStreamingInput ? codemodeScript(block.input) : null;
  const codemode = codemodeCode === null ? null : { code: codemodeCode, ...codemodeCalls(result?.details) };
  // A running script's progress snapshot has calls but no content yet.
  const codemodeRunning = codemode !== null && result !== undefined && result.content.length === 0;

  // Flat arguments as rows instead of a JSON blob, unless the card has a view of
  // its own (a write's file text, codemode, an applied patch). See `lib/tool-fields.ts`.
  // Input still streaming goes through pi's own partial parse, the arguments its
  // TUI draws live, so a multi-line command shows its lines before the call ends.
  // Gated on detailsRendered, not expanded: a collapsing card keeps its rows
  // until the fold finishes, or the collapse would blank mid-motion.
  const toolFields =
    detailsRendered && writtenFileText === null && codemode === null && patchFiles === null
      ? toolFieldsOfInput(isStreamingInput ? parseStreamingJson(block.rawInput) : block.input)
      : null;

  // `server/tool` instead of the registered `mcp__server__tool`, as pi's TUI shows it.
  const mcpLabel = mcpToolLabel(block.toolName, result?.details);

  // Result display
  const resultContent = result ? (codemode ? stripCodemodeHeader(result.content) : result.content) : [];
  const joinedResultText = result
    ? resultContent.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultText = mcpLabel && joinedResultText !== null ? prettyMcpResultText(joinedResultText) : joinedResultText;
  const resultImages = getMessageImages(resultContent);
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = (result?.isError ?? false)
    || (isApplyPatchToolName(block.toolName) && applyPatchResultHasFailures(result?.details));
  const subagent = isSubagentToolDetails(result?.details) ? result.details : null;
  // A subagent row opens its work log in the right pane (R37): it is an action,
  // not a fold — no inline detail exists for it (ZCode's summaryAction). The
  // streaming store feeds a running call's details the same way (R46), so the
  // row opens the child's live transcript while the run is under way.
  const opensSubagent = Boolean(subagent && onOpenSubagent);
  const codemodeCallCount = codemode ? codemode.calls.length + codemode.omitted : 0;
  // §2.1: a diff's +N/-N as green/red mono counts on the row; the counts ride
  // the applied patch when there is one, else the result's patch text.
  const diffCounts = useMemo(
    () => (patchFiles ? countPatchLines(patchFiles) : resultDiffText ? countPatchText(resultDiffText) : null),
    [patchFiles, resultDiffText],
  );

  // Unresolved while no result has landed: the card carries the pending sweep.
  // A subagent still queued/starting/running keeps that look even though its
  // live details are attached (they exist to open the work log, not to read
  // as a result).
  const subagentLive = subagent !== null
    && (subagent.status === "queued" || subagent.status === "starting" || subagent.status === "running");
  const isPending = result === undefined || subagentLive;

  // §2.8/§2.1: an MCP row's kind word is "MCP"; the server/tool pair rides
  // the kindDetail slot beside it (the raw registered name when no result
  // has named the server and tool).
  const isMcpRow = mcpLabel !== null || block.toolName.startsWith("mcp__");
  const mcpDetail = mcpLabel ? `${mcpLabel.server}/${mcpLabel.tool}` : block.toolName;
  // The kind word: the localized vocabulary while a family is known, the
  // registered name otherwise (extension tools, codemode).
  const kindIds = toolKindMessageIds(block.toolName);
  const kindWord = isMcpRow ? t("chat.toolCall.kind.mcp") : kindIds ? t(isPending ? kindIds.running : kindIds.done) : block.toolName;
  const kindClassName = `tool-kind${isPending || codemodeRunning ? " animated-gradient-text" : ""}`;
  // The summary line (§2.1): separator + the rolling primary text; the roll
  // key is the call's stage, so a streaming append refreshes in place and
  // only a real stage change (running → done/failed) rolls.
  const summaryText = isStreamingInput
    ? t("chat.generatingToolInput")
    : (patchLabel ?? (codemode ? codemodeScriptPreview(codemode.code) : getToolPreview(block, resultPatchPath)));
  const summaryKey = `${block.toolCallId}:${isStreamingInput ? "input" : isPending ? "running" : isError ? "error" : "done"}`;
  // File-family calls (read/write/edit) show ZCode's structured file chip
  // instead of a flat path string (screenshot parity 2026-10-31).
  const fileSummary = !isStreamingInput ? fileChipFor(block, resultPatchPath) : null;

  if (["ask_user", "goal_update", "todo_write"].includes(block.toolName) && !isStreamingInput) {
    return <ConversationTool block={block} result={result} />;
  }

  return (
    <div
      className={`tool-call-card${isError ? " is-error" : ""}${isPending ? " is-pending" : ""}`}
      style={{ overflow: "hidden" }}
    >
      {/* ── Tool call header (§2.1 anatomy: the row never trades color for a state) ── */}
      <div style={{ display: "flex", alignItems: "stretch", minWidth: 0 }}>
        <button
          type="button"
          className="tool-summary"
          aria-expanded={subagent && onOpenSubagent ? undefined : expanded}
          title={subagent && onOpenSubagent ? t("subagent.openTab") : undefined}
          aria-label={subagent && onOpenSubagent ? t("subagent.openTab") : undefined}
          onClick={subagent && onOpenSubagent
            ? () => onOpenSubagent(subagent.sessionId, subagent.description || subagent.profile)
            : toggleExpanded}
        >
          <span className="tool-glyph-slot"><ToolGlyph name={block.toolName} /></span>
          {isMcpRow ? (
            <>
              <span className={kindClassName}>{kindWord}</span>
              <span className="tool-kind-detail" title={block.toolName}>{mcpDetail}</span>
            </>
          ) : (
            <>
              <span className={kindClassName}>{kindWord}</span>
              {block.toolName.toLowerCase().startsWith("bash ") && (
                <span className="tool-source-label">{block.toolName.slice("bash ".length)}</span>
              )}
            </>
          )}
          {fileSummary ? (
            <>
              <span className="tool-separator">·</span>
              {/* ZCode's file chip (§2.1 renderers.tsx:98-111): 16px file
                  icon, leaf name in the subtle ink, the directory behind it
                  in the subtlest — structured, not one flat path string. */}
              <span className="tool-file-chip" title={fileSummary.path}>
                <span className="tool-file-chip-icon">{getFileIcon(fileSummary.leaf, 14)}</span>
                <span className="tool-file-name">{fileSummary.leaf}</span>
                {fileSummary.dir && <span className="tool-file-dir">{fileSummary.dir}</span>}
              </span>
            </>
          ) : summaryText !== "" && (
            <>
              <span className="tool-separator">·</span>
              <QueuedSummaryText contentKey={summaryKey} enabled={!expanded} className="tool-summary-text" text={summaryText} />
            </>
          )}
          {diffCounts && (
            diffCounts.removed > 0 || diffCounts.added > 0 ? (
              <span className="tool-diffcount">
                {diffCounts.added > 0 && <span className="tool-diffcount-added">+{diffCounts.added}</span>}
                {diffCounts.removed > 0 && <span className="tool-diffcount-removed">-{diffCounts.removed}</span>}
              </span>
            ) : null
          )}
          {codemodeCallCount > 0 && (
            <span className="tool-status">
              {codemodeCallCount === 1 ? t("codemode.callCountOne") : t("codemode.callCount", { count: codemodeCallCount })}
            </span>
          )}
          {isError && resultText !== null && resultText !== "" && <ToolErrorStatus errorText={resultText} />}
          {/* A subagent row is the open action itself (ZCode's summaryAction):
              the trailing icon says "opens the right pane", no chevron/fold. */}
          {subagent && onOpenSubagent
            ? <span className="tool-open-affordance" aria-hidden="true"><BotIcon size={16} /></span>
            : <ChevronRightIcon size={16} className="tool-chevron" />}
        </button>
      </div>

      {/* ── Expanded: input args (only when no richer view exists); a codemode script in place of its JSON ── */}
      {detailsRendered && !opensSubagent && (
        <div className="pi-disclose" data-open={expanded} inert={!expanded || undefined}>
          <div className="pi-disclose-body">
            {/* The run time left the summary row (R23d): ZCode's compact row
                carries none. pi's recorded duration stays reachable in the
                detail surface as a caption. */}
            {duration !== undefined && (
              <div className="tool-duration">{t("chat.toolCall.took", { time: formatToolDuration(duration) })}</div>
            )}
            {/* §2.5: the panel chrome and padding sit INSIDE the animated
                node; on the node itself they would outlive the collapse. */}
            <div className="tool-detail-surface">
              {(isStreamingInput || !isEditTool) && !patchFiles && (
                toolFields ? (
                  <div
                    style={{
                      padding: "6px 10px 8px",
                    }}
                  >
                    <ToolFieldRows fields={toolFields} />
                  </div>
                ) : (
                  <pre
                    style={{
                      margin: 0,
                      padding: "8px 10px",
                      color: "var(--text-muted)",
                      fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))",
                      lineHeight: 1.5,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                    }}
                  >
                    {codemode ? codemode.code.replace(/\r/g, "").trimEnd() : inputStr}
                  </pre>
                )
              )}
              {/* ── Expanded: the calls a codemode script made (§8.3: nested rows, full detail) ── */}
              {codemode && (
                <CodemodeCallList calls={codemode.calls} omitted={codemode.omitted} />
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Expanded: applied-patch diff, the paired result, and the result images ── */}
      {detailsRendered && !opensSubagent && (
        <div className="pi-disclose" data-open={expanded} inert={!expanded || undefined}>
          <div className="pi-disclose-body">
            {/* M-finding-4: ZCode's edit diffs do NOT sit in the §2.5 execute
                panel — EditInlineDiffContent carries its own rounded-xl border
                bg-card frame flush to the tool-content edges, and multi-file
                diffs ride the ml-2 rail (edit.tsx:216). Only execute-style
                content (fields / raw text results) keeps the padded surface. */}
            {patchFiles && (
              <div className={patchFiles.length > 1 ? "tool-diff-rail" : undefined}>
                <div className="tool-diff-frame">
                  <SplitFilesView files={patchFiles} />
                </div>
              </div>
            )}
            {result && !patchFiles && !codemodeRunning && resultDiff && (
              <div className="tool-diff-frame">
                <PairedDiffResult diff={resultDiff} />
              </div>
            )}
            {((result && patchFiles && isError) || (result && !patchFiles && !codemodeRunning && !resultDiff && (!resultIsEmpty || resultImages.length === 0))) && (
              <div className="tool-detail-surface">
                <PairedResult
                  text={resultText ?? ""}
                  isEmpty={resultIsEmpty}
                  isError={isError}
                />
              </div>
            )}
            {/* Result images live INSIDE the fold (user order 2026-10-31):
                collapsed, the row is just the summary — the image opens with
                the detail and closes with it. */}
            {resultImages.length > 0 && <ResultImages images={resultImages} />}
          </div>
        </div>
      )}
    </div>
  );
}

/** +added/-removed counts over a parsed patch, for the row's mono counts. */
function countPatchLines(files: SplitDiffFile[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    for (const line of unifiedDiffLines(file)) {
      if (line.type === "added") added++;
      else if (line.type === "removed") removed++;
    }
  }
  return { added, removed };
}

/** The same counts straight from a patch text the card did not parse into files. */
function countPatchText(text: string): { added: number; removed: number } | null {
  const files = parseUnifiedPatch(text);
  return files ? countPatchLines(files) : null;
}

interface ResultDiff {
  text: string;
}

function PairedDiffResult({ diff }: {
  diff: ResultDiff;
}) {
  // The diff frame (M-finding-4) carries the border and card background; the
  // result diff renders flush inside it, no second chrome of its own.
  return <SplitPatchView text={diff.text} />;
}

function SplitPatchView({ text }: { text: string }) {
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  if (!files) return <PatchTextView text={text} />;
  return <SplitFilesView files={files} />;
}

/** Two code columns side by side, or one column of patch lines. */
export type PatchDiffLayout = "split" | "stacked";

/**
 * The patch as the viewport can show it. Two columns need two code columns side
 * by side, which a phone does not have: there the same rows read as one column
 * — a removed line above the line that replaces it, each with its own number —
 * the way the file viewer's diff has always been drawn. See `unifiedDiffLines()`.
 */
function SplitFilesView({ files }: { files: SplitDiffFile[] }) {
  const layout: PatchDiffLayout = useIsMobile() ? "stacked" : "split";
  return <PatchDiffFiles files={files} layout={layout} />;
}

export function PatchDiffFiles({ files, layout }: { files: SplitDiffFile[]; layout: PatchDiffLayout }) {
  const { t } = useI18n();
  const showFileHeaders = files.length > 1;

  return (
    <div style={{ maxHeight: 560, overflowY: "auto", overflowX: "hidden", background: "var(--card)" }}>
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          style={{
            minWidth: 0,
            borderTop: fileIndex === 0 ? "none" : "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontWeight: "var(--font-mono-weight)",
            fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))",
            lineHeight: 1.55,
          }}
        >
          {showFileHeaders && layout === "split" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
              }}
            >
               <SplitDiffHeader title={file.oldPath || t("i18n.before")} side="left" />
               <SplitDiffHeader title={file.newPath || t("i18n.after")} side="right" />
            </div>
          )}

          {showFileHeaders && layout === "stacked" && stackedFilePath(file) && (
            <div
              title={stackedFilePath(file)}
              style={{
                position: "sticky",
                top: 0,
                zIndex: 1,
                padding: "5px 10px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {stackedFilePath(file)}
            </div>
          )}

          {layout === "split" && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            {file.rows.map((row, rowIndex) => {
              if (row.type === "hunk") {
                return null;
              }
              if (row.type === "gap") {
                return <DiffGapRow key={rowIndex} gap={row} />;
              }

              return (
                <div key={rowIndex} style={{ display: "contents" }}>
                  <SplitDiffCellView cell={row.left} side="left" />
                  <SplitDiffCellView cell={row.right} side="right" />
                </div>
              );
            })}
          </div>
          )}

          {layout === "stacked" && unifiedDiffLines(file).map((line, lineIndex) => (
            line.type === "gap"
              ? <DiffGapRow key={lineIndex} gap={line} />
              : <StackedDiffLineView key={lineIndex} line={line} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Unchanged lines the patch leaves out between two hunks, across the whole width. */
function DiffGapRow({ gap }: { gap: SplitDiffGap }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        gridColumn: "1 / -1",
        padding: "0 10px",
        color: "var(--text-dim)",
        background: "var(--bg-panel)",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        userSelect: "none",
      }}
    >
      {gap.count === null ? "⋯" : `⋯ ${diffGapLabel(gap.count, t)}`}
    </div>
  );
}

/** The file a stacked section is named for: the new path, the one that survives, unless the file was deleted. */
function stackedFilePath(file: SplitDiffFile): string {
  if (file.newPath && file.newPath !== "/dev/null") return file.newPath;
  return file.oldPath || file.newPath || "";
}

function StackedDiffLineView({ line }: { line: UnifiedDiffLine }) {
  return (
    <SplitDiffCellView
      side="right"
      cell={{
        // One gutter, so a removed line keeps the old number and everything else the new one.
        lineNo: line.type === "removed" ? line.oldLineNo : line.newLineNo,
        text: line.text,
        type: line.type,
      }}
    />
  );
}

function SplitDiffHeader({ title, side }: { title: string; side: "left" | "right" }) {
  return (
    <div
      title={title}
      style={{
        padding: "5px 10px",
        color: "var(--text-dim)",
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {title}
    </div>
  );
}

function SplitDiffCellView({ cell, side }: { cell: SplitDiffCell; side: "left" | "right" }) {
  const bg =
    cell.type === "added"
      ? "color-mix(in srgb, var(--feedback-ok) 12%, transparent)"
      : cell.type === "removed"
      ? "color-mix(in srgb, var(--feedback-danger) 13%, transparent)"
      : cell.type === "empty"
      ? "var(--bg-subtle)"
      : "transparent";
  const marker =
    cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " ";
  const markerColor =
    cell.type === "added" ? "var(--feedback-ok)" : cell.type === "removed" ? "var(--feedback-danger)" : "var(--text-dim)";

  return (
    <div
      style={{
        display: "flex",
        minWidth: 0,
        background: bg,
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      <span
        style={{
          width: 42,
          padding: "0 6px",
          textAlign: "right",
          color: "var(--text-dim)",
          userSelect: "none",
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {cell.lineNo ?? ""}
      </span>
      <span
        style={{
          width: 18,
          padding: "0 5px",
          color: markerColor,
          userSelect: "none",
          fontWeight: cell.type === "context" || cell.type === "empty" ? 400 : 700,
          flexShrink: 0,
        }}
      >
        {marker}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          padding: "0 10px 0 0",
          color: cell.type === "empty" ? "var(--text-dim)" : "var(--text)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {cell.text || "\u00a0"}
      </span>
    </div>
  );
}

function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div style={{ maxHeight: 520, overflowY: "auto", overflowX: "hidden", fontFamily: "var(--font-mono)", fontWeight: "var(--font-mono-weight)", fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))", lineHeight: 1.55, minWidth: 0 }}>
      {lines.map((line, i) => {
        const kind =
          line.startsWith("@@") ? "hunk" :
          line.startsWith("+") && !line.startsWith("+++") ? "added" :
          line.startsWith("-") && !line.startsWith("---") ? "removed" :
          "context";
        const bg =
          kind === "added" ? "color-mix(in srgb, var(--feedback-ok) 12%, transparent)" :
          kind === "removed" ? "color-mix(in srgb, var(--feedback-danger) 13%, transparent)" :
          kind === "hunk" ? "color-mix(in srgb, var(--accent) 12%, transparent)" :
          "transparent";
        const color =
          kind === "added" ? "var(--feedback-ok)" :
          kind === "removed" ? "var(--feedback-danger)" :
          kind === "hunk" ? "var(--accent)" :
          "var(--text)";

        return (
          <div
            key={i}
            style={{
              display: "flex",
              background: bg,
              borderLeft: kind === "added"
                ? "3px solid var(--feedback-ok)"
                : kind === "removed"
                ? "3px solid var(--feedback-danger)"
                : kind === "hunk"
                ? "3px solid var(--accent)"
                : "3px solid transparent",
            }}
          >
            <span
              style={{
                width: 48,
                padding: "0 8px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                textAlign: "right",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              {i + 1}
            </span>
            <span style={{ padding: "0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color }}>
              {line || "\u00a0"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Split diff rows for an apply_patch-style tool call.
 *
 * Prefers parsing the V4A patch document from the call input. The extension's
 * applied result preview contains the complete old/new file with unchanged
 * lines, so it is only used as a fallback when the call input is unavailable.
 * A single call may contain several file operations — each becomes its own
 * file section.
 */
function getApplyPatchFiles(block: ToolCallContent, result?: ToolResultMessage): SplitDiffFile[] | null {
  if (!isApplyPatchToolName(block.toolName)) return null;

  const fromInput = parseApplyPatchInput(getApplyPatchInputText(block.input, block.rawInput));
  if (fromInput) return fromInput;

  const details = result && !result.isError ? (result as ToolResultMessage & { details?: unknown }).details : undefined;
  if (isRecord(details)) {
    const fromPreview = applyPatchPreviewToFiles(details.preview);
    if (fromPreview) return fromPreview;
  }

  return null;
}

/** Header label listing the files targeted by an apply_patch call. */
function summarizeApplyPatchInput(block: ToolCallContent): string | null {
  const paths = extractApplyPatchPaths(getApplyPatchInputText(block.input, block.rawInput));
  if (paths.length === 0) return null;
  return paths.join(", ").slice(0, 120);
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return null;

  const patch = typeof details.patch === "string" ? details.patch : null;
  if (patch) return { text: patch };

  const diff = typeof details.diff === "string" ? details.diff : null;
  if (diff) return { text: diff };

  return null;
}

/** The file a result's patch changed, when it changed exactly one. */
function singlePatchPath(text: string | undefined): string | null {
  if (!text) return null;
  const files = parseUnifiedPatch(text);
  return files?.length === 1 ? stackedFilePath(files[0]) || null : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ResultImages({ images }: { images: ImageContent[] }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        padding: "10px",
        background: "var(--bg)",
        borderTop: "1px solid var(--border)",
      }}
    >
      {images.map((image, index) => {
        const src = imageSource(image);
        if (!src) return null;
        return (
          <ImagePreview
            key={`${src}-${index}`}
            src={src}
            style={{ maxWidth: "100%" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              loading="lazy"
              style={{
                display: "block",
                maxWidth: "min(100%, 720px)",
                maxHeight: 520,
                borderRadius: "var(--radius-sm)",
                objectFit: "contain",
                border: "1px solid var(--border)",
              }}
            />
          </ImagePreview>
        );
      })}
    </div>
  );
}

function PairedResult({ text, isEmpty, isError }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        borderTop: `1px solid color-mix(in srgb, ${isError ? "var(--feedback-danger) 30%" : "var(--feedback-ok) 15%"}, transparent)`,
        background: isError ? "color-mix(in srgb, var(--feedback-danger) 4%, transparent)" : "var(--bg-subtle)",
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "var(--feedback-danger)" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
          fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))",
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: 400,
          background: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
        {isEmpty ? t("i18n.noOutput") : text}
      </pre>
    </div>
  );
}

function CompactionMessageView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  // Collapsed by default, as in pi's TUI: a summary can run to pages.
  const [expanded, setExpanded] = useState(false);
  const detailsRendered = useDelayedUnmount(expanded);
  const summary = getMessageText(message.content);
  const time = formatTime(message.timestamp);
  const tokensBefore = (message.details as { tokensBefore?: unknown } | undefined)?.tokensBefore;
  // pi's showCacheMissNotices (#1265): what the compaction billed, in its card.
  const costNotice = getTranscriptNotices(message).find((notice) => notice.kind === "summary_cost" && notice.source === "compaction");

  return (
    <div className="transcript-note">
      <button
        type="button"
        aria-expanded={expanded}
        title={expanded ? t("i18n.collapse") : t("i18n.expand")}
        className="transcript-note-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        <svg className="transcript-note-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span className="transcript-note-kind">compaction</span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", fontSize: "var(--conversation-font-size, 16px)", fontWeight: 500, lineHeight: 1.4 }}>
            {t("i18n.conversationCompacted")}
          </span>
          {typeof tokensBefore === "number" && Number.isFinite(tokensBefore) && (
            <span style={{ display: "block", marginTop: 2, color: "var(--text-muted)", fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))", lineHeight: 1.5 }}>
              {t("i18n.compactedFromTokens", { tokens: tokensBefore.toLocaleString() })}
            </span>
          )}
          {costNotice && (
            <span style={{ display: "block", marginTop: 2, color: TRANSCRIPT_NOTICE_WARNING_COLOR, fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))", lineHeight: 1.5 }}>
              {transcriptNoticeText(t, costNotice)}
            </span>
          )}
        </span>
        {time && <span className="transcript-note-time">{time}</span>}
      </button>
      {detailsRendered && (
        <div className="pi-disclose" data-open={expanded}>
          <div className="pi-disclose-body">
            <div className="transcript-note-details">
              <CompactionSummaryDetails summary={summary} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function CompactionSummaryDetails({ summary }: { summary: string }) {
  const { t } = useI18n();
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ marginBottom: 10, color: "var(--text)", fontSize: "var(--conversation-font-size, 16px)", lineHeight: 1.5 }}>
         {t("i18n.compactionDescription")}
      </div>
      {parsedSummary.body ? (
        <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
      ) : (
         <span style={{ color: "var(--text-dim)", fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))" }}>{t("i18n.noSummary")}</span>
      )}
      <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
    </div>
  );
}

function CompactionFileMetadata({ readFiles, modifiedFiles }: { readFiles: string[]; modifiedFiles: string[] }) {
  const { t } = useI18n();
  const total = readFiles.length + modifiedFiles.length;
  if (total === 0) return null;

  const parts = [];
  if (readFiles.length > 0) parts.push(`${readFiles.length} read`);
  if (modifiedFiles.length > 0) parts.push(`${modifiedFiles.length} modified`);

  return (
    <details className="compaction-file-details">
       <summary>{t("i18n.fileContext", { details: parts.join(", ") })}</summary>
       <div className="pi-disclose">
         <div className="pi-disclose-body">
           {modifiedFiles.length > 0 && <CompactionFileList title={t("i18n.modifiedFiles")} files={modifiedFiles} />}
           {readFiles.length > 0 && <CompactionFileList title={t("i18n.readFiles")} files={readFiles} />}
         </div>
       </div>
    </details>
  );
}

function CompactionFileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
  );
}

function CustomMessageView({ message, cwd, onOpenFile }: { message: CustomMessage; cwd?: string; onOpenFile?: (filePath: string, page?: number) => void }) {
  const { t } = useI18n();
  // Expanded by default: pi's TUI always draws a displayed custom message in full.
  const [contentExpanded, setContentExpanded] = useState(true);
  const bodyRendered = useDelayedUnmount(contentExpanded);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const detailsBodyRendered = useDelayedUnmount(detailsExpanded);
  const [copied, setCopied] = useState(false);
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const title = formatCustomType(message.customType);
  const time = formatTime(message.timestamp);

  const copyContent = () => {
    copyText(text || detailsText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="transcript-note">
      <button
        type="button"
        onClick={() => setContentExpanded((v) => !v)}
        aria-expanded={contentExpanded}
        title={contentExpanded ? t("i18n.collapse") : t("i18n.expand")}
        className="transcript-note-toggle transcript-note-toggle--down"
      >
        <span className="transcript-note-kind">{title}</span>
        {!bodyRendered && text && (
          <span style={{ color: "var(--text-dim)", fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
            {text.slice(0, 300).replace(/\s+/g, " ").trim()}
          </span>
        )}
        {time && <span className="transcript-note-time">{time}</span>}
        <svg className="transcript-note-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {bodyRendered && (
        <div className="pi-disclose" data-open={contentExpanded}>
          <div className="pi-disclose-body">
            <div className="transcript-note-details">
              {images.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0 }}>
                  {images.map((img, i) => {
                    const src = imageSource(img);
                    if (!src) return null;
                    return (
                      <ImagePreview key={i} src={src}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={src}
                          alt=""
                          style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                        />
                      </ImagePreview>
                    );
                  })}
                </div>
              )}
              {text ? <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>{text}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))" }}>{t("i18n.noMessage")}</span>}

              {(text || detailsText || hasDetails) && (
                <div className="transcript-note-actions">
                  {(text || detailsText) && (
                    <button
                      type="button"
                      onClick={copyContent}
                      className="transcript-note-action"
                    >
                      {copied ? t("i18n.copied") : t("i18n.copy")}
                    </button>
                  )}
                  {hasDetails && (
                    <button
                      type="button"
                      onClick={() => setDetailsExpanded((v) => !v)}
                      className="transcript-note-action"
                      aria-expanded={detailsExpanded}
                    >
                      {detailsExpanded ? t("i18n.hideDetails") : t("i18n.showDetails")}
                    </button>
                  )}
                </div>
              )}

              {hasDetails && detailsBodyRendered && (
                <div className="pi-disclose" data-open={detailsExpanded}>
                  <div className="pi-disclose-body">
                    <pre
                      style={{
                        margin: 0,
                        padding: "9px 10px",
                        background: "var(--bg)",
                        color: "var(--text-muted)",
                        fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))",
                        lineHeight: 1.5,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxHeight: 360,
                        overflow: "auto",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {detailsText}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getToolCallInputText(block: ToolCallContent): string {
  return block.rawInput ?? JSON.stringify(block.input, null, 2);
}

const WRITE_VIEW_KEYS = new Set(["path", "file_path", "content"]);

// A write's file text in place of its JSON: the header already shows the path.
// Streamed input is still incomplete JSON, and any other argument (a mode, a
// title) would vanish from this view, so those calls, and an empty file, keep
// the generic view.
function getWrittenFileText(block: ToolCallContent): string | null {
  if (block.rawInput !== undefined || !isWriteToolName(block.toolName)) return null;
  const { content } = block.input;
  if (typeof content !== "string" || content === "") return null;
  return Object.keys(block.input).every((key) => WRITE_VIEW_KEYS.has(key)) ? content : null;
}

const TOOL_FIELD_LABEL: CSSProperties = {
  padding: "4px 12px 4px 0",
  color: "var(--text-dim)",
  fontSize: "var(--conversation-font-size-caption, calc(var(--chat-content-font-size, 16px) - 3px))",
  whiteSpace: "nowrap",
  verticalAlign: "top",
};

const TOOL_FIELD_VALUE: CSSProperties = {
  padding: "4px 0",
  color: "var(--text-muted)",
  fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))",
  fontFamily: "var(--font-mono)",
  overflowWrap: "anywhere",
};

// A value with newlines of its own keeps them, scrolled in place.
const TOOL_FIELD_BLOCK: CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  maxHeight: 260,
  overflow: "auto",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg)",
  font: "inherit",
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
};

function ToolFieldRows({ fields }: { fields: ToolField[] }) {
  return (
    <table style={{ borderCollapse: "collapse" }}>
      <tbody>
        {fields.map((field) => (
          <tr key={field.key}>
            <td style={TOOL_FIELD_LABEL}>{field.key}</td>
            <td style={TOOL_FIELD_VALUE}>
              {field.multiline ? <pre style={TOOL_FIELD_BLOCK}>{field.value}</pre> : field.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatCustomType(type: string): string {
  return type || "extension";
}


/** The file a read/write/edit call touches, split for the row's file chip. */
function fileChipFor(block: ToolCallContent, resultPatchPath: string | null): { path: string; leaf: string; dir: string } | null {
  const name = block.toolName.toLowerCase();
  const isFileTool = /^(read|readfile|read_file|write|writefile|write_file|edit|multiedit|multi_edit|apply_patch|patch)$/.test(name);
  if (!isFileTool) return null;
  const input = block.input;
  const raw = input && typeof input === "object"
    ? (("path" in input && typeof input.path === "string") ? input.path
      : ("file_path" in input && typeof input.file_path === "string") ? input.file_path
      : resultPatchPath)
    : resultPatchPath;
  if (!raw) return null;
  const path = raw.trim();
  if (path === "") return null;
  const slash = path.lastIndexOf("/");
  const leaf = slash >= 0 ? path.slice(slash + 1) : path;
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  return { path, leaf, dir };
}

function getToolPreview(block: ToolCallContent, resultPatchPath: string | null): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if (resultPatchPath) return resultPatchPath.slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): StatPart[] {
  // pi's TUI footer: ↑1.2k ↓567 R8.9k W12, with its formatTokens().
  const parts: StatPart[] = [];
  if (usage.input) parts.push({ icon: "up", before: "↑", text: formatNoticeTokens(usage.input) });
  if (usage.output) parts.push({ icon: "down", before: "↓", text: formatNoticeTokens(usage.output) });
  if (usage.cacheRead) parts.push({ text: `R${formatNoticeTokens(usage.cacheRead)}` });
  if (usage.cacheWrite) parts.push({ text: `W${formatNoticeTokens(usage.cacheWrite)}` });
  if (usage.cost?.total) parts.push({ text: `$${usage.cost.total.toFixed(4)}` });
  return parts;
}

// "took 12s" as a clock and "12s": the words around the time stay as hidden
// text, wherever the language puts them.
function formatDurationPart(label: string, time: string): StatPart {
  const index = label.indexOf(time);
  if (index < 0) return { text: label };
  return { icon: "clock", before: label.slice(0, index), text: time, after: label.slice(index + time.length) };
}

/** One count of the stats line; `before`/`after` are copied and read aloud, not shown. */
interface StatPart {
  text: string;
  icon?: "up" | "down" | "clock";
  before?: string;
  after?: string;
}

const STAT_ICON_PATHS = {
  up: "M6 10.5V1.5M2.5 5 6 1.5 9.5 5",
  down: "M6 1.5v9M2.5 7 6 10.5 9.5 7",
  clock: "M6 1.25a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 1 0 0-9.5M6 3.5V6l1.75 1",
};

// Unseen but still text: font-size 0 stays in a copied selection, where a
// zero-width overflow box drops it and sr-only's absolute box adds a line break.
const HIDDEN_STAT_TEXT: CSSProperties = { fontSize: 0 };

// ↑ and ↓ come from whatever font has them: Segoe UI or a CJK fallback on
// Windows draws them small, heavy or off the baseline. The icons are drawn
// here instead; their text stays, zero-width, for copying and screen readers.
// Everything stays inline: a block or flex box would copy as a line break
// between the icon and its count.
function UsagePart({ part }: { part: StatPart }) {
  if (!part.icon) return <span>{part.text}</span>;
  return (
    <span>
      {part.before && <span style={HIDDEN_STAT_TEXT}>{part.before}</span>}
      <svg
        width={part.icon === "clock" ? 10 : 9}
        height={part.icon === "clock" ? 10 : 9}
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        style={{ display: "inline", verticalAlign: part.icon === "clock" ? "-0.1em" : "-0.05em", marginRight: part.icon === "clock" ? 3 : 1 }}
      >
        <path d={STAT_ICON_PATHS[part.icon]} />
      </svg>
      {part.text}
      {part.after && <span style={HIDDEN_STAT_TEXT}>{part.after}</span>}
    </span>
  );
}

function BashExecutionView({ message, sessionId }: { message: BashExecutionMessage; sessionId?: string }) {
  const { t } = useI18n();
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);

  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
  const fullOutputUrl = sessionId && message.fullOutputPath
    ? `/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}`
    : null;
  const showFullButton = message.truncated && fullOutputUrl && fullOutput === null;
  const displayOutput = fullOutput ?? message.output;

  async function loadFullOutput() {
    if (!fullOutputUrl) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const res = await fetch(fullOutputUrl);
      const d = await res.json() as { success?: boolean; data?: { output?: string }; error?: string };
      if (d.success) {
        setFullOutput(d.data?.output ?? "");
      } else {
        setFullError(d.error ?? "failed");
      }
    } catch (e) {
      setFullError(String(e));
    } finally {
      setLoadingFull(false);
    }
  }

  // Reuse the existing ToolCallBlock so user-run bash looks identical to an
  // agent-run bash tool call: same header, collapse behavior, result pane.
  // Synthesize an equivalent ToolCallContent + ToolResultMessage pair.
  const toolName = message.excludeFromContext ? "bash (local)" : "bash";
  const block: ToolCallContent = {
    type: "toolCall",
    toolCallId: `bash-${message.timestamp ?? ""}`,
    toolName,
    input: { command: message.command },
  };
  const result: ToolResultMessage | undefined = isPending
    ? undefined
    : {
        role: "toolResult",
        toolCallId: block.toolCallId,
        toolName,
        content: displayOutput ? [{ type: "text", text: displayOutput }] : [],
        isError,
        timestamp: message.timestamp,
      };

  return (
    <div style={{ margin: "6px 0" }}>
      <ToolCallBlock block={block} result={result} />
      {message.truncated && fullOutputUrl && (
        <div style={{ padding: "4px 10px", fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))", marginTop: -1 }}>
          {showFullButton && (
            <button
              onClick={loadFullOutput}
              disabled={loadingFull}
              style={{ background: "none", border: "none", color: "var(--accent)", cursor: loadingFull ? "default" : "pointer", fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))", padding: 0, textDecoration: "underline" }}
            >
              {loadingFull ? t("chat.loadingFullOutput") : t("chat.viewFullOutput")}
            </button>
          )}
          <a
            href={`${fullOutputUrl}&download=1`}
            style={{ marginLeft: showFullButton ? 10 : 0, color: "var(--accent)", fontSize: "var(--conversation-font-size-meta, calc(var(--chat-content-font-size, 16px) - 2px))", textDecoration: "underline" }}
          >
            {t("chat.downloadFullOutput")}
          </a>
          {fullError && <span style={{ marginLeft: 6, color: "var(--text-dim)", fontSize: "var(--conversation-font-size-caption, calc(var(--chat-content-font-size, 16px) - 3px))" }}>({fullError})</span>}
        </div>
      )}
    </div>
  );
}
