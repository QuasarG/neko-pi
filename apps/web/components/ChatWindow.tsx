"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import Image from "next/image";
import { parseInjectedContext, type InjectedContextParts } from "@earendil-works/pi-coding-agent/injected-context";
import { ToolCallGroupCard, countToolCallRun, toolCallFamily, type ToolCallFamily } from "./ToolCallGroupCard";
import { ConversationTurnNavigator, type ConversationTurnNavigatorItem } from "./ConversationTurnNavigator";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, BlockingExtensionUiRequest, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolCallContent, ToolResultMessage } from "@/lib/types";
import { normalizeCustomPanelLines } from "@/lib/ansi";
import { splitNoticeText } from "@/lib/notice-text";
import { EXTENSION_DIALOG_BASE_WIDTH, fitExtensionDialogWidth } from "@/lib/extension-dialog-fit";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { collapsesProcessDetails, countToolCallBlocks, getDisplayableAssistantBlocks, isHiddenCustomMessage, isMessageGroupAnchor, splitFinalAssistantBlocks } from "@/lib/message-display";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { getFinalAnswerViews, keepWrittenFiles, type FinalAnswerViews } from "@/lib/turn-views";
import { formatTurnDuration, getTurnDurationMs } from "@/lib/turn-duration";
import { buildQuotedSelection } from "@/lib/quoted-selection";
import { dropMentionText, splitDroppedItems, uploadFiles, type DroppedItem } from "@/lib/file-upload-client";
import { MessageView } from "./MessageView";
import { AskUserDock } from "./AskUserDock";
import { matchAskUserQuestion } from "@/lib/ask-user-view";
import { MarkdownBody } from "./MarkdownBody";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChevronRightIcon } from "./tool-icons";
import { ProcessDetailsGroup } from "./ProcessDetailsGroup";
import { useDelayedUnmount } from "@/hooks/useDelayedUnmount";
import { ExtensionStatusBar, extractGoalStatus } from "./ExtensionStatusBar";
import {
  buildStatusPanelModel,
  ConversationStatusPanel,
  type StatusPanelSubagent,
  type StatusPanelVariant,
} from "./conversation-status-panel";
import { BackgroundWorkBadges } from "./background-work-badges";
import {
  backgroundJobsToWorks,
  latestTodoWriteItems,
  useSessionBackgroundJobs,
} from "@/lib/status-panel-data";
import { AnsiText } from "./AnsiText";
import { useI18n } from "@/hooks/useI18n";
import { phaseLabel } from "@/lib/chat-phase-label";
import { useAgentSession, type AgentEndInfo, type NewSessionChoices, type NoticeItem } from "@/hooks/useAgentSession";
import { selectHasStreamingContent, selectIsStreaming, selectStreamingMessage, useStreamingSelector } from "@/hooks/useStreamingSelector";
import type { StreamingStore } from "@/lib/streaming-message";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useScrollbarVisibility } from "@/hooks/useScrollbarVisibility";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { DebugClientSession } from "@/lib/debug-types";
import type { AppUpdateResponse } from "@/lib/api-types";
import type { ToolEntry } from "@/lib/types";
import type { SettingsSection } from "@/lib/settings-navigation";
import { getTranscriptNotices, summarizeCacheMisses, type CacheMissSummary, type TranscriptNotice } from "@/lib/transcript-notices";
import { cacheMissSummaryText, TranscriptNoticeLines } from "@/components/TranscriptNotices";
import { findChatScrollAnchor, type ChatScrollPosition } from "@/lib/chat-scroll-position";
import {
  captureScrollDistance,
  getNextVisibleCount,
  getPromptAnchorSpacerHeight,
  getVisibleRenderWindow,
  isScrollAtTail,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";

interface Props {
  session: SessionInfo | null;
  searchTarget?: { sessionId: string; entryId: string; blockIndex?: number } | null;
  onSearchTargetHandled?: (target: { sessionId: string; entryId: string }) => void;
  initialScrollPosition?: ChatScrollPosition | null;
  onScrollPositionChange?: (sessionId: string, position: ChatScrollPosition) => void;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  /** Shown above the composer while a fresh composer is still empty: where its session starts. */
  newSessionContextBar?: ReactNode;
  /** A fresh composer's model and reasoning picks, carried from the composer it replaces. */
  initialNewSessionChoices?: NewSessionChoices | null;
  onNewSessionChoicesChange?: (choices: NewSessionChoices) => void;
  onAgentEnd?: (end: AgentEndInfo) => void;
  onToolEnd?: (toolName: string) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, locked: boolean) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  /** Registers the debug panel's read-only reader of this chat's stream and lease. */
  onDebugSnapshotReaderChange?: (reader: (() => DebugClientSession) | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  /** The live output rate of the streaming reply, or null when no run is streaming. */
  onStreamRate?: (rate: number | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onBranchesPanelOpen?: () => void;
  onModelCommand?: (search: string) => void;
  onThinkingCommand?: (search: string) => void;
  onNewSessionCommand?: () => void;
  onDebugCommand?: () => void;
  onExportCommand?: () => void;
  onResumeCommand?: () => void;
  onTrustCommand?: () => void;
  onAuthCommand?: (mode: "login" | "logout", provider: string) => void;
  onHelpCommand?: (kind: "changelog" | "hotkeys") => void;
  onImportCommand?: () => void;
  onShareCommand?: () => void;
  onBugCommand?: (hint: string, model: { provider: string; modelId: string } | null) => void;
  /** Opens Settings on a section: a bare `/mcp` that pi's built-in MCP extension owns opens Settings › MCP. */
  onOpenSettings?: (section: SettingsSection) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** The active session family's running subagents, as the top-right status card's agent rows. AppShell owns the family data. */
  statusPanelSubagents?: StatusPanelSubagent[];
  /** Opens a background bash job's output in a right-panel tab. AppShell owns the tabs. */
  onOpenBackgroundBash?: (workId: string, title: string) => void;
  /** Opens a user message's injected-context detail in the right panel (R26). */
  onOpenInjectedContext?: (payload: { key: string; title: string; parts: InjectedContextParts }) => void;
  /** Files dropped onto the chat were written into the working directory. */
  onFilesUploaded?: () => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  onAskInNewChat?: (prompt: string, sourceSessionId: string, sourceEntryId: string) => Promise<void>;
  quoteSelectionEnabled?: boolean;
  initialPrompt?: string;
  onInitialPromptConsumed?: () => void;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
  /** Keeps the completion sound's audio running until the returned release is called. */
  holdAudio?: () => () => void;
}
const CHAT_COLUMN_PADDING = 16;

// One update check per page. Every fresh composer mounts the header again
// (each move of the new-session bar does), and a link that turned up late
// each time would lengthen the versions line under the reader's eyes; from
// the second header on it is there in the first paint.
let appUpdateCheck: Promise<AppUpdateResponse | null> | null = null;
let appUpdateFound: AppUpdateResponse | null = null;

function checkAppUpdate(): Promise<AppUpdateResponse | null> {
  appUpdateCheck ??= fetch("/api/app-update")
    .then(async (response) => {
      if (!response.ok) return null;
      const result = await response.json() as AppUpdateResponse;
      return result.updateAvailable && result.latestVersion && result.releaseUrl ? result : null;
    })
    .then((result) => {
      appUpdateFound = result;
      return result;
    })
    .catch(() => {
      // Update checks are best-effort and must not interrupt a new session;
      // a later header asks again.
      appUpdateCheck = null;
      return null;
    });
  return appUpdateCheck;
}

function NewSessionUpdateLink({
  label,
}: {
  label: (version: string) => string;
}) {
  const [update, setUpdate] = useState<AppUpdateResponse | null>(() => appUpdateFound);

  useEffect(() => {
    if (appUpdateFound) return;
    let cancelled = false;
    void checkAppUpdate().then((result) => {
      if (!cancelled && result) setUpdate(result);
    });
    return () => { cancelled = true; };
  }, []);

  if (!update) return null;
  const accessibleLabel = label(update.latestVersion);

  // In the versions line, after the version in use: "→ v<latest> ↗".
  return (
    <>
      <span className="new-session-meta-arrow" aria-hidden="true">→</span>
      <a
        className="new-session-update"
        href={update.releaseUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={accessibleLabel}
        aria-label={accessibleLabel}
      >
        v{update.latestVersion}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 17 17 7" />
          <path d="M7 7h10v10" />
        </svg>
      </a>
    </>
  );
}

// Working indicator (ZCode ChatLoading, catalog §4.4). The 3x3 pixel matrix
// orbits on 110ms steps (delay index * 110); the center cell stays static, so
// it still receives a delay it never uses — the catalog lists nine steps.
const CHAT_LOADING_PIXEL_DELAYS = Array.from({ length: 9 }, (_, index) => index * 110);

/** The mono timer text: tabular minutes:seconds.deci — "1:59.1". */
export function formatWorkingTimer(elapsedMs: number): string {
  const total = Math.max(0, elapsedMs);
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const tenths = Math.floor((total % 1_000) / 100);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

/** ZCode's ChatLoading row: pixel matrix + shimmer label + mono timer. */
function ChatLoadingRow({ label, elapsedMs, slow = false }: { label: string; elapsedMs: number; slow?: boolean }) {
  return (
    <div role="status" className="chat-loading" data-chat-loading-animate="true">
      <span className={`chat-loading-pixels${slow ? " is-slow" : ""}`} aria-hidden="true">
        {CHAT_LOADING_PIXEL_DELAYS.map((delayMs, index) => (
          <i
            key={delayMs}
            className={`chat-loading-pixel${index === 4 ? " is-center" : ""}`}
            style={{ animationDelay: `${delayMs}ms` }}
          />
        ))}
      </span>
      <span className="chat-loading-label">{label}</span>
      <span className="chat-loading-timer">{formatWorkingTimer(elapsedMs)}</span>
    </div>
  );
}

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/** ZCode's AssistantHistoryStatus (ConversationTurnGroup.tsx:646-716): a
 * full-width band under the turn's work — the localized "Worked for {time}"
 * at body size in 60% ink, a 16px chevron at 70% opacity, and a 50% border
 * underneath. The old visible count list ("2 messages · 3 tool calls") dies;
 * the counts and the folded cache misses stay reachable through aria-label
 * and the title. */
/** A turn's cache-miss notices, hoisted out of the stream (user order 2026-11-01:
 *  the warning belongs right after the query, not between tool calls). */
function collectTurnCacheMissNotices(messages: AgentMessage[], fromIdx: number, toIdx: number): TranscriptNotice[] {
  const notices: TranscriptNotice[] = [];
  for (let i = fromIdx + 1; i < toIdx && i < messages.length; i++) {
    for (const notice of getTranscriptNotices(messages[i])) {
      if (notice.kind === "cache_miss") notices.push(notice);
    }
  }
  return notices;
}

/** ZCode's family vocabulary for merged call runs (§2.8 kind words). The
 *  changes family reads as 更改 (chat.toolGroup.changesLabel, ZCode's
 *  ChangesGroup title); the children keep their 编辑 kind + file chip. */
const FAMILY_KIND_KEY = {
  terminal: "chat.toolCall.kind.terminal",
  changes: "chat.toolGroup.changesLabel",
  explore: "chat.toolGroup.explore",
} as const;

export function ChatWindow({ session, searchTarget, onSearchTargetHandled, initialScrollPosition, onScrollPositionChange, sessionRunning, newSessionCwd, newSessionDraftKey, newSessionContextBar, initialNewSessionChoices, onNewSessionChoicesChange, onAgentEnd, onToolEnd, onAttentionNeeded, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onDebugSnapshotReaderChange, onSessionStatsChange, onStreamRate, onSessionStatsPanelOpen, onBranchesPanelOpen, onModelCommand, onThinkingCommand, onNewSessionCommand, onDebugCommand, onExportCommand, onResumeCommand, onTrustCommand, onAuthCommand, onHelpCommand, onImportCommand, onShareCommand, onBugCommand, onOpenSettings, onContextUsageChange, onOpenFile, onFilesUploaded, onOpenSubagent, onAskInNewChat, quoteSelectionEnabled = false, initialPrompt, onInitialPromptConsumed, soundEnabled = true, onSoundToggle, playDoneSound = () => {}, unlockAudio, holdAudio, statusPanelSubagents, onOpenBackgroundBash, onOpenInjectedContext }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const completionNotificationsEnabled = session?.relation?.kind !== "subagent";

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const extensionDialogShownRef = useRef(false);
  const wrappedOnAgentEnd = useCallback((end: AgentEndInfo) => {
    // A run someone stopped did not finish anything, and one whose subagents still work did not finish the task.
    if (completionNotificationsEnabled && soundEnabledRef.current && !end.aborted && !end.subagentsActive) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.(end);
  }, [completionNotificationsEnabled, onAgentEnd]);

  const initialScrollPositionRef = useRef(searchTarget ? null : initialScrollPosition ?? null);
  const [pendingScrollRestore, setPendingScrollRestore] = useState<Extract<ChatScrollPosition, { atBottom: false }> | null>(() => {
    const position = initialScrollPositionRef.current;
    return position && !position.atBottom ? position : null;
  });
  const [restoreAnchorReady, setRestoreAnchorReady] = useState(false);

  const {
    loading, error, messages, activeToolResults, entryIds, messageKeys, historyCursor, hasEarlierMessages, streamingStore,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, missingCwd, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices, extensionDialog, waitingExtensionDialogCount, extensionCustomUi, waitingExtensionCustomUiCount, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput, setNoticePaused, addNotice,
    isAutoModelSelection,
    isAutoThinkingSelection,
    defaultModel,
    savedDefaultThinkingLevel,
    agentPhase,
    isNew,
    editEntryId,
    showScrollToBottom,
    sessionIdRef, scrollContainerRef,
    lastUserMsgRef, promptAnchorActive,
    handleSend, handleAbort, handleFork, handleEditContent, handleSubmitEdit, cancelEdit, handleModelChange,
    handleSteer, handleFollowUp, handlePromptWithStreamingBehavior,
    dismissCompactError,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleThinkingLevelChange, handleSetDefaultModel, handleSetDefaultThinkingLevel, loadSlashCommands, scrollUserMsgToTop,
    loadContext, activeLeafId, scrollToBottom, scrollToMessage,
  } = useAgentSession({
    session, sessionRunning, newSessionCwd, newSessionDraftKey, initialNewSessionChoices, onNewSessionChoicesChange, onAgentEnd: wrappedOnAgentEnd, onToolEnd, onAttentionNeeded, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsPanelOpen, onBranchesPanelOpen, onModelCommand, onThinkingCommand, onNewSessionCommand, onDebugCommand, onExportCommand, onResumeCommand, onTrustCommand, onAuthCommand, onHelpCommand, onImportCommand, onShareCommand, onBugCommand,
    onOpenSettings, onDebugSnapshotReaderChange, t,
    deferInitialScroll: Boolean(pendingScrollRestore),
  });
  // Only whether a reply is streaming and has content yet: the chunks themselves
  // re-render StreamingReply alone.
  const isStreaming = useStreamingSelector(streamingStore, selectIsStreaming);
  const hasStreamingContent = useStreamingSelector(streamingStore, selectHasStreamingContent);
  const getStreamingMessage = useCallback(() => streamingStore.getState().streamingMessage, [streamingStore]);
  const sessionBusy = agentRunning || bashRunning;

  // ── Top-right status card (R19 catalog C) ──────────────────────────────
  // The goal line's placement is this card (R19(c)): a parseable projection
  // leaves the status bar, the bar keeps everything else. The todo list is the
  // latest todo_write snapshot; bash works come from the background-jobs
  // registry via the poll hook; subagent rows are handed in by AppShell.
  const [statusPanelVariantOverride, setStatusPanelVariantOverride] = useState<StatusPanelVariant | null>(null);
  const [terminalSectionOpen, setTerminalSectionOpen] = useState<boolean | undefined>(undefined);
  const [agentSectionOpen, setAgentSectionOpen] = useState<boolean | undefined>(undefined);
  const { goal: goalProjection, statuses: nonGoalStatuses } = useMemo(
    () => extractGoalStatus(extensionStatuses),
    [extensionStatuses],
  );
  // The background-jobs text row dies with the composer badge (catalog A1):
  // the extension's `background` line stays the wake signal for the poll, but
  // the bar never prints it — the badge and the card own that count.
  const barStatuses = useMemo(
    () => nonGoalStatuses.filter((status) => status.key !== "background"),
    [nonGoalStatuses],
  );
  const todoItems = useMemo(() => latestTodoWriteItems(messages), [messages]);
  const statusPanelSubagentRows = useMemo(() => statusPanelSubagents ?? [], [statusPanelSubagents]);
  // The extension's `background` status line is the push signal that the job
  // table changed; the poll is the truth it wakes.
  const backgroundStatusWakeKey = extensionStatuses.find((status) => status.key === "background")?.text ?? "";
  const backgroundJobs = useSessionBackgroundJobs(session?.id ?? null, {
    sessionBusy,
    wakeKey: backgroundStatusWakeKey,
  });
  const statusWorks = useMemo(() => backgroundJobsToWorks(backgroundJobs), [backgroundJobs]);
  const statusPanelModel = useMemo(
    () => buildStatusPanelModel({
      goal: goalProjection,
      todoItems,
      works: statusWorks,
      subagents: statusPanelSubagentRows,
    }),
    [goalProjection, todoItems, statusWorks, statusPanelSubagentRows],
  );
  // The composer badge's click (catalog A.2): the composer is the entry to ALL
  // live activity — one click expands the panel with every non-empty section.
  const handleOpenStatusPanel = useCallback(() => {
    setStatusPanelVariantOverride("panel");
    setTerminalSectionOpen(statusWorks.length > 0);
    setAgentSectionOpen(statusPanelSubagentRows.length > 0);
  }, [statusWorks.length, statusPanelSubagentRows.length]);
  const handleGoalCommand = useCallback((command: "/goal pause" | "/goal resume") => {
    void handleSend(command);
  }, [handleSend]);
  // While this session's run is under way its chime may come with the phone
  // locked, where a suspended context cannot start again (#1157).
  useEffect(() => {
    if (!agentRunning || !holdAudio) return;
    return holdAudio();
  }, [agentRunning, holdAudio]);
  const [quotedSelection, setQuotedSelection] = useState<{
    text: string;
    top: number;
    left: number;
    sourceEntryId?: string;
  } | null>(null);
  const [quoteInputOpen, setQuoteInputOpen] = useState(false);
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const quotePopoverRef = useRef<HTMLDivElement | null>(null);
  const quoteChatInputRef = useRef<ChatInputHandle | null>(null);
  const closeQuotedSelection = useCallback(() => {
    setQuotedSelection(null);
    setQuoteInputOpen(false);
    setQuoteError(null);
  }, []);

  useEffect(() => {
    if (!quoteSelectionEnabled) closeQuotedSelection();
  }, [quoteSelectionEnabled, closeQuotedSelection]);

  const captureQuotedSelection = useCallback(() => {
    if (!quoteSelectionEnabled || quoteInputOpen) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const root = messageContentRef.current;
    if (!selection || selection.isCollapsed || !range || !root || !root.contains(range.commonAncestorContainer)) {
      setQuotedSelection(null);
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setQuotedSelection(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement;
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element
      : range.startContainer.parentElement;
    const end = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer as Element
      : range.endContainer.parentElement;
    const sourceEntryId = [ancestor, start, end]
      .map((element) => element?.closest<HTMLElement>("[data-message-role=\"assistant\"]")?.dataset.entryId)
      .find((entryId): entryId is string => Boolean(entryId));
    setQuotedSelection({
      text,
      top: Math.min(window.innerHeight - 44, rect.bottom + 8),
      left: Math.max(64, Math.min(window.innerWidth - 64, rect.left + rect.width / 2)),
      sourceEntryId,
    });
  }, [quoteSelectionEnabled, quoteInputOpen]);

  useEffect(() => {
    if (!quoteInputOpen || !quotedSelection) return;
    quoteChatInputRef.current?.insertIfEmpty(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
  }, [quoteInputOpen, quotedSelection, t]);

  useLayoutEffect(() => {
    const popover = quotePopoverRef.current;
    if (!popover || !quotedSelection) return;
    const viewport = window.visualViewport;
    const position = () => {
      const rect = popover.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      popover.style.top = `${Math.max(top + 8, Math.min(quotedSelection.top, top + (viewport?.height ?? window.innerHeight) - rect.height - 8))}px`;
      popover.style.left = `${Math.max(left + 8, Math.min(quotedSelection.left - rect.width / 2, left + (viewport?.width ?? window.innerWidth) - rect.width - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [quotedSelection, quoteInputOpen, quoteError]);

  useEffect(() => {
    if (!quotedSelection) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!quoteInputOpen && !quotePopoverRef.current?.contains(event.target as Node)) closeQuotedSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!quoteSubmitting) closeQuotedSelection();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [quotedSelection, quoteInputOpen, quoteSubmitting, closeQuotedSelection]);

  const askSelectionHere = useCallback(() => {
    if (!quotedSelection) return;
    chatInputRef?.current?.insertText(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
    // No `removeAllRanges()` here: inserting focuses the composer, and that
    // focus already collapses the page's selection. Calling it afterwards also
    // clears the composer's own selection and drops its caret to offset 0
    // (#1319), so the quote would be typed in front of instead of after.
    closeQuotedSelection();
  }, [chatInputRef, quotedSelection, closeQuotedSelection, t]);

  const askSelectionInNewChat = useCallback(async (prompt: string) => {
    const sourceSessionId = sessionIdRef.current ?? session?.id;
    if (quoteSubmitting || !prompt.trim() || !quotedSelection?.sourceEntryId || !sourceSessionId || !onAskInNewChat) return;
    setQuoteSubmitting(true);
    setQuoteError(null);
    unlockAudio?.();
    try {
      await onAskInNewChat(
        prompt,
        sourceSessionId,
        quotedSelection.sourceEntryId,
      );
      closeQuotedSelection();
    } catch (error) {
      quoteChatInputRef.current?.restoreSubmission(prompt);
      setQuoteError(error instanceof Error ? error.message : String(error));
    } finally {
      setQuoteSubmitting(false);
    }
  }, [onAskInNewChat, quotedSelection, quoteSubmitting, session?.id, sessionIdRef, closeQuotedSelection, unlockAudio]);

  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (loading || error || !initialPrompt || initialPromptSentRef.current) return;
    initialPromptSentRef.current = true;
    onInitialPromptConsumed?.();
    void handleSend(initialPrompt);
  }, [initialPrompt, loading, error, handleSend, onInitialPromptConsumed]);

  // One sound when a dialog appears with none on screen. A dialog queued behind
  // another one surfaces the moment the user answers that one, so it stays quiet.
  useEffect(() => {
    const surfaced = Boolean(extensionDialog) && !extensionDialogShownRef.current;
    extensionDialogShownRef.current = Boolean(extensionDialog);
    if (!completionNotificationsEnabled || !surfaced) return;
    playDoneSoundRef.current();
  }, [completionNotificationsEnabled, extensionDialog]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  // State, not a ref: the sentinel can appear with nothing else changing (a
  // finished turn regrouped into more rows), and must get an observer then.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  const restoreStartedRef = useRef(false);
  // --- Entry-fade gate (R46) ---
  // The streaming fade (.transcript-entry-in) must only play for entries that
  // arrive after this mount's first paint. Two classes of keys are exempt:
  // everything the first render sees (the whole transcript an already-loaded
  // session opens with), and everything that lands while a lazy-load page is
  // being prepended. The prepend window is timing-sensitive: loadContext
  // prepends via setState that flushes in a macrotask AFTER its promise's
  // microtask continuations, so the window opens in loadOlderPage on every
  // request and closes only in the historyCursor effect once the prepended
  // render has committed (or at once in loadOlderPage when nothing landed —
  // never in a continuation). While the window is open, every key of the
  // render joins the exempt set: those mounts are prepends, not arrivals.
  // `animated` latches: once a wrapper gets the class it keeps it for its
  // lifetime, so a later exempt sweep can never cut a running fade short.
  const entryFadeRef = useRef<{ exempt: Set<string>; animated: Set<string> } | null>(null);
  if (entryFadeRef.current === null) {
    entryFadeRef.current = { exempt: new Set(messageKeys), animated: new Set() };
  } else if (loadingOlderRef.current) {
    for (const key of messageKeys) entryFadeRef.current.exempt.add(key);
  }
  const pendingScrollRestoreRef = useRef(pendingScrollRestore);
  pendingScrollRestoreRef.current = pendingScrollRestore;
  const [pendingSearchScroll, setPendingSearchScroll] = useState<Props["searchTarget"]>(null);
  const searchMessage = messages[entryIds.indexOf(pendingSearchScroll?.entryId ?? "")];
  const searchBlock = searchMessage?.role === "assistant"
    ? (pendingSearchScroll?.blockIndex === undefined
      ? searchMessage.content.find((block) => block.type === "text")
      : searchMessage.content[pendingSearchScroll.blockIndex])
    : undefined;
  const searchHistoryRef = useRef({ entryIds, historyCursor, hasEarlierMessages });
  searchHistoryRef.current = { entryIds, historyCursor, hasEarlierMessages };
  // The cursor of the older page asked for last, kept until the next cursor
  // renders: the page lands and the prepended render commits, and an observer
  // report in between still holds this cursor.
  const requestedCursorRef = useRef<string | null>(null);
  // In-flight count for the R46 window: several lazy-loads can overlap (a
  // restore loop's pages, a concurrent sentinel report), and the window may
  // only close once the LAST page's prepended render has committed.
  const loadingOlderCountRef = useRef(0);
  const loadOlderPage = useCallback(async (sid: string, before: string, options?: { tail?: number; signal?: AbortSignal }) => {
    requestedCursorRef.current = before;
    // Open the R46 prepend window here, on every page request: loadContext
    // prepends via setState after its await, and that render flushes in a
    // later macrotask — a clear running in this promise's continuation (a
    // microtask) would land BEFORE the prepended render, so the window would
    // never cover it. Instead, the window closes after the render commits in
    // the historyCursor effect below — unless nothing rendered (failure,
    // abort, empty page) or another page is still in flight, when it closes
    // right here.
    loadingOlderCountRef.current += 1;
    loadingOlderRef.current = true;
    let context: Awaited<ReturnType<typeof loadContext>>;
    try {
      context = await loadContext(sid, activeLeafId, before, options);
    } finally {
      loadingOlderCountRef.current -= 1;
    }
    // Nothing landed, so the same page may be asked for again.
    if (!context && requestedCursorRef.current === before) requestedCursorRef.current = null;
    if ((!context || context.messages.length === 0) && loadingOlderCountRef.current === 0) {
      loadingOlderRef.current = false;
    }
    return context;
  }, [activeLeafId, loadContext]);
  useEffect(() => {
    // A reloaded history can come back to a cursor asked for before.
    if (historyCursor !== requestedCursorRef.current) requestedCursorRef.current = null;
    // The post-render close of the R46 prepend window: loadContext sets the
    // new cursor and the prepended messages in one batch, so when this effect
    // runs the ledger has already seen the prepended render with the window
    // open (the render's own read of the ref happened during render, before
    // any effect). Clearing here — never in a promise continuation — is what
    // makes the window actually cover the prepend; only when no further page
    // is in flight (a restore loop's next page reopens it on its own request).
    if (loadingOlderCountRef.current === 0) loadingOlderRef.current = false;
  }, [historyCursor]);

  useLayoutEffect(() => {
    const sessionId = session?.id;
    const container = scrollContainerRef.current;
    const content = messageContentRef.current;
    if (!sessionId || !onScrollPositionChange || !container || !content) return;
    return () => {
      if (pendingScrollRestoreRef.current) return;
      if (isScrollAtTail(container.scrollTop, container.clientHeight, container.scrollHeight)) {
        onScrollPositionChange(sessionId, { atBottom: true });
        return;
      }
      const viewportTop = container.getBoundingClientRect().top;
      const candidates = Array.from(content.children).flatMap((element) => {
        if (!(element instanceof HTMLElement) || !element.dataset.entryId) return [];
        const rect = element.getBoundingClientRect();
        return [{ entryId: element.dataset.entryId, top: rect.top, bottom: rect.bottom }];
      });
      const anchor = findChatScrollAnchor(candidates, viewportTop);
      if (!anchor) return;
      onScrollPositionChange(sessionId, {
        atBottom: false,
        ...anchor,
        oldestEntryId: searchHistoryRef.current.historyCursor,
      });
    };
  }, [loading, onScrollPositionChange, scrollContainerRef, session?.id]);

  useEffect(() => {
    if (searchTarget) setPendingScrollRestore(null);
  }, [searchTarget]);

  useEffect(() => {
    const position = pendingScrollRestore;
    const sessionId = session?.id;
    if (!position || !sessionId || loading || searchTarget || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    const controller = new AbortController();

    const locate = async () => {
      const initialHistory = searchHistoryRef.current;
      if (initialHistory.entryIds.includes(position.anchorEntryId)) {
        setVisibleCount((current) => Math.max(current, initialHistory.entryIds.length * 2));
        setRestoreAnchorReady(true);
        return;
      }

      loadingOlderRef.current = true;
      let before = initialHistory.historyCursor;
      let hasMore = initialHistory.hasEarlierMessages;
      // No finally here on purpose: the R46 prepend window must not be closed
      // in this promise continuation (a microtask) — each loadOlderPage opens
      // it per request and the historyCursor effect closes it once the
      // prepended render commits. Every exit below either follows a page that
      // landed (the effect will close) or one that did not (loadOlderPage
      // closed it itself).
      while (hasMore && before && !controller.signal.aborted) {
        const context = await loadOlderPage(sessionId, before, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!context) {
          scrollToBottom("instant");
          setPendingScrollRestore(null);
          return;
        }
        setVisibleCount((current) => current + Math.max(VISIBLE_PAGE_SIZE, context.messages.length * 2));
        if (context.entryIds.includes(position.anchorEntryId)) {
          setRestoreAnchorReady(true);
          return;
        }
        if (context.oldestEntryId === position.oldestEntryId) break;
        before = context.oldestEntryId;
        hasMore = context.hasMore;
      }
      if (!controller.signal.aborted) {
        scrollToBottom("instant");
        setPendingScrollRestore(null);
      }
    };

    void locate();
    return () => {
      controller.abort();
      // A branch change cancels restoration and must reveal the new context.
      setPendingScrollRestore(null);
    };
  }, [activeLeafId, loadOlderPage, loading, pendingScrollRestore, scrollToBottom, searchTarget, session?.id]);

  useLayoutEffect(() => {
    const position = pendingScrollRestore;
    const content = messageContentRef.current;
    if (!position || !content || searchTarget) return;
    const element = Array.from(content.children).find((candidate) => (
      candidate instanceof HTMLElement && candidate.dataset.entryId === position.anchorEntryId
    ));
    if (element instanceof HTMLElement) {
      scrollToMessage(element, position.anchorOffset);
      setPendingScrollRestore(null);
      return;
    }
    if (restoreAnchorReady) {
      scrollToBottom("instant");
      setPendingScrollRestore(null);
    }
  }, [entryIds, pendingScrollRestore, restoreAnchorReady, scrollToBottom, scrollToMessage, searchTarget, visibleCount]);

  useEffect(() => {
    if (!searchTarget || loading) return;
    const controller = new AbortController();
    const locate = async () => {
      const history = searchHistoryRef.current;
      let found = history.entryIds.includes(searchTarget.entryId);
      if (!found && !sessionBusy && history.hasEarlierMessages && history.historyCursor && !loadingOlderRef.current) {
        loadingOlderRef.current = true;
        const container = scrollContainerRef.current;
        if (container) prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
        // ponytail: one extra page of 200 entries; deeper or other-branch hits just open the session.
        const context = await loadOlderPage(searchTarget.sessionId, history.historyCursor, { tail: 200, signal: controller.signal });
        // No clear here: the window closes after the page's render commits
        // (the historyCursor effect) or at once if nothing landed.
        found = Boolean(context?.entryIds.includes(searchTarget.entryId));
      }
      if (controller.signal.aborted) return;
      if (found) {
        prevScrollDistanceRef.current = null;
        setVisibleCount((current) => Math.max(current, (searchHistoryRef.current.entryIds.length + 200) * 2));
        setPendingSearchScroll(searchTarget);
      } else {
        onSearchTargetHandled?.(searchTarget);
      }
    };
    void locate();
    return () => controller.abort();
  }, [searchTarget, loading, sessionBusy, loadOlderPage, onSearchTargetHandled, scrollContainerRef]);

  useLayoutEffect(() => {
    if (!pendingSearchScroll || pendingSearchScroll !== searchTarget) return;
    const selector = `[data-entry-id="${CSS.escape(pendingSearchScroll.entryId)}"]`;
    const element = scrollContainerRef.current?.querySelector<HTMLElement>(searchMessage?.role === "user" ? selector : `${selector} [data-search-target]`);
    if (element) {
      scrollToMessage(element);
      element.animate([
        { backgroundColor: "var(--bg-selected)" },
        { backgroundColor: "transparent" },
      ], { duration: 2500 });
    }
    setPendingSearchScroll(null);
    onSearchTargetHandled?.(pendingSearchScroll);
  }, [pendingSearchScroll, searchTarget, searchMessage, scrollContainerRef, scrollToMessage, onSearchTargetHandled]);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, load the next page of older messages.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        // Skip while a page is already loading.
        if (loadingOlderRef.current) return;
        if (!hasEarlierMessages) {
          // Everything is loaded, yet the sentinel shows: the messages render as
          // more rows than the window holds (an answer and its thinking are
          // two), so widen the window. The observer is renewed with it, in case
          // the sentinel stays in view.
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
          setVisibleCount((current) => getNextVisibleCount(current));
          return;
        }
        // Fetch the previous page from the server and prepend it (loadContext
        // handles prepend + scroll anchoring).
        const oldestId = historyCursor;
        // Its page already landed; the next cursor has not rendered yet.
        if (!oldestId || oldestId === requestedCursorRef.current) return;
        const sid = session?.id ?? sessionIdRef.current;
        if (!sid) return;
        loadingOlderRef.current = true;
        prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
        // No clear on settle: the page's render commits first and the
        // historyCursor effect closes the window after it (or loadOlderPage
        // itself, when nothing landed).
        void loadOlderPage(sid, oldestId);
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, visibleCount, historyCursor, hasEarlierMessages, session, loadOlderPage, sessionIdRef, scrollContainerRef]);

  // Keep the rendered window at least as large as what's loaded, so prepended
  // (older) pages stay visible instead of being sliced off the top.
  useEffect(() => {
    setVisibleCount((current) => Math.max(current, messages.length));
  }, [messages.length]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
  }, [visibleCount, scrollContainerRef]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
      sessionStats.totalActiveMs ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  // Images attach to the prompt. Other files go through the file explorer's
  // upload into the working directory, never replacing a file already there,
  // and come back as @mentions. The composer's attach button takes the same
  // path, for phones that cannot drop files.
  const uploadDroppedFiles = useCallback(async (files: File[]) => {
    const cwd = session?.cwd ?? newSessionCwd;
    if (!cwd) {
      addNotice({ type: "warning", message: t("chat.dropNeedsCwd") });
      return;
    }
    try {
      const { status, data } = await uploadFiles(cwd, files, "skip");
      if (status !== 200 && status !== 207) throw new Error(data.error ?? `HTTP ${status}`);
      const uploaded = data.uploaded ?? [];
      const skipped = data.skipped ?? [];
      const mentions = dropMentionText(files, [...uploaded, ...skipped]);
      if (mentions) chatInputRef?.current?.insertText(mentions);
      if (uploaded.length > 0) {
        addNotice({ type: "success", message: t("chat.dropUploaded", { count: uploaded.length }) });
        onFilesUploaded?.();
      }
      if (skipped.length > 0) {
        addNotice({ type: "warning", message: t("chat.dropAlreadyExists", { names: skipped.join(", ") }) });
      }
      for (const failure of data.errors ?? []) {
        addNotice({ type: "error", message: t("chat.dropFailed", { message: `${failure.name}: ${failure.error}` }) });
      }
    } catch (uploadError) {
      addNotice({ type: "error", message: t("chat.dropFailed", { message: uploadError instanceof Error ? uploadError.message : String(uploadError) }) });
    }
  }, [addNotice, chatInputRef, newSessionCwd, onFilesUploaded, session?.cwd, t]);

  const onDrop = useCallback((items: DroppedItem[]) => {
    const { images, files, folders } = splitDroppedItems(items);
    if (images.length > 0) chatInputRef?.current?.addImages(images);
    if (folders.length > 0) {
      addNotice({ type: "warning", message: t("chat.dropFoldersUnsupported", { names: folders.join(", ") }) });
    }
    if (files.length > 0) void uploadDroppedFiles(files);
  }, [addNotice, chatInputRef, t, uploadDroppedFiles]);

  const onAttachFiles = useCallback((files: File[]) => {
    onDrop(files.map((file) => ({ kind: "file", file })));
  }, [onDrop]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  // Stable Map identity: `messages` doesn't change during streaming updates
  // (the streaming message lives in streamingStore), so memoized MessageViews
  // skip re-rendering on every message_update event. An inline `new Map()`
  // here used to defeat MessageView's memo() on each streamed chunk.
  const toolResultsMap = useMemo(() => {
    const map = new Map(activeToolResults);
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }
    return map;
  }, [activeToolResults, messages]);
  // Same idea for the copies a grouped turn passes MessageView (see getFinalAnswerViews).
  const finalAnswerViewCache = useMemo(() => new WeakMap<AssistantMessage, FinalAnswerViews>(), []);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  // ── Left turn navigator (S1): one item per user query ─────────────────
  const conversationLayoutRef = useRef<HTMLDivElement | null>(null);
  const turnNavigatorItems = useMemo<ConversationTurnNavigatorItem[]>(() => {
    const items: ConversationTurnNavigatorItem[] = [];
    messages.forEach((message, idx) => {
      const text = getUserInputText(message);
      if (text === null) return;
      // The navigator previews the HUMAN query: strip the harness's trailing
      // injection blocks (message_time / runtime_activity / ...).
      const humanText = (parseInjectedContext(text)?.userText ?? text).trim();
      if (humanText === "") return;
      // The hover card's second block: the turn's final summary reply (the
      // last assistant text before the next query), clipped to 240 chars.
      let assistantPreview = "";
      for (let j = idx + 1; j < messages.length; j++) {
        const next = messages[j];
        if (isMessageGroupAnchor(next) || next.role === "user") break;
        if (next.role !== "assistant") continue;
        const textBlocks = (next.content ?? []).filter((block): block is { type: "text"; text: string } => block.type === "text" && block.text.trim().length > 0);
        const lastText = textBlocks.at(-1)?.text?.trim();
        if (lastText) assistantPreview = lastText;
      }
      items.push({
        key: messageKeys[idx] ?? `user-${idx}`,
        entryId: entryIds[idx],
        text: humanText,
        ...(assistantPreview ? { assistantPreview: assistantPreview.slice(0, 240) } : {}),
      });
    });
    return items;
  }, [messages, messageKeys, entryIds]);
  const jumpToQuery = useCallback((item: ConversationTurnNavigatorItem, behavior: ScrollBehavior) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const findTarget = (): HTMLElement | null => {
      if (item.entryId) {
        const byId = container.querySelector<HTMLElement>(
          `[data-message-role="user"][data-entry-id="${CSS.escape(item.entryId)}"]`,
        );
        if (byId) return byId;
      }
      // No entry id yet (the run is live): the rendered window is a suffix of
      // the items, so count from the end.
      const index = turnNavigatorItems.indexOf(item);
      if (index < 0) return null;
      const roots = container.querySelectorAll<HTMLElement>('[data-message-role="user"]');
      const rootIndex = roots.length - 1 - (turnNavigatorItems.length - 1 - index);
      return rootIndex >= 0 ? roots[rootIndex] ?? null : null;
    };
    const scrollToTarget = (target: HTMLElement) => {
      const top = target.getBoundingClientRect().top
        - container.getBoundingClientRect().top
        + container.scrollTop
        - 16;
      container.scrollTo({ top: Math.max(0, top), behavior });
    };
    const target = findTarget();
    if (target) {
      scrollToTarget(target);
      return;
    }
    // The query sits above the rendered window: page it in, then scroll once
    // its element lands.
    setVisibleCount((current) => Math.max(current, messages.length * 2));
    let attempts = 0;
    const retry = () => {
      const element = findTarget();
      if (element) {
        scrollToTarget(element);
        return;
      }
      attempts += 1;
      if (attempts < 30) requestAnimationFrame(retry);
    };
    requestAnimationFrame(retry);
  }, [messages.length, scrollContainerRef, turnNavigatorItems]);

  const isEmptyNew = isNew && messages.length === 0 && !isStreaming && !sessionBusy;
  useScrollbarVisibility(scrollContainerRef, Boolean(session?.id) || !isEmptyNew);
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  const promptAnchorSpacerRef = useRef<HTMLDivElement | null>(null);
  const promptAnchorSpacerHeightRef = useRef(0);
  const promptAnchorMeasureFrameRef = useRef<number | null>(null);
  const promptAnchorAdjustmentDoneRef = useRef(false);
  const promptAnchorUpdateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const spacer = promptAnchorSpacerRef.current;
    if (!agentRunning || !promptAnchorActive) {
      promptAnchorUpdateRef.current = null;
      promptAnchorSpacerHeightRef.current = 0;
      promptAnchorAdjustmentDoneRef.current = false;
      if (spacer) spacer.style.height = "";
      return;
    }

    const container = scrollContainerRef.current;
    const messageContent = messageContentRef.current;
    const userMessage = lastUserMsgRef.current;
    if (!container || !messageContent || !userMessage || !spacer) return;

    let disposed = false;
    const updatePromptAnchorSpacer = () => {
      if (
        disposed
        || scrollContainerRef.current !== container
        || messageContentRef.current !== messageContent
        || lastUserMsgRef.current !== userMessage
        || promptAnchorSpacerRef.current !== spacer
      ) return;

      const containerTop = container.getBoundingClientRect().top;
      const userMessageTop = userMessage.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const targetTop = Math.max(0, userMessageTop - 16);
      const contentEnd = spacer.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const nextPromptAnchorSpacerHeight = getPromptAnchorSpacerHeight(
        targetTop,
        contentEnd,
        container.clientHeight,
      );

      const isInitialMeasurement = !promptAnchorAdjustmentDoneRef.current;
      const needsInitialAdjustment = isInitialMeasurement
        && nextPromptAnchorSpacerHeight > 0;
      if (isInitialMeasurement) promptAnchorAdjustmentDoneRef.current = true;
      if (nextPromptAnchorSpacerHeight === promptAnchorSpacerHeightRef.current) return;

      promptAnchorSpacerHeightRef.current = nextPromptAnchorSpacerHeight;
      spacer.style.height = nextPromptAnchorSpacerHeight > 0
        ? `${nextPromptAnchorSpacerHeight}px`
        : "";
      if (needsInitialAdjustment) scrollUserMsgToTop();
    };

    promptAnchorUpdateRef.current = updatePromptAnchorSpacer;
    const schedulePromptAnchorMeasure = () => {
      if (disposed || promptAnchorMeasureFrameRef.current !== null) return;
      promptAnchorMeasureFrameRef.current = requestAnimationFrame(() => {
        promptAnchorMeasureFrameRef.current = null;
        updatePromptAnchorSpacer();
      });
    };

    updatePromptAnchorSpacer();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedulePromptAnchorMeasure);
    observer?.observe(container);
    observer?.observe(messageContent);
    observer?.observe(userMessage);
    return () => {
      disposed = true;
      if (promptAnchorUpdateRef.current === updatePromptAnchorSpacer) {
        promptAnchorUpdateRef.current = null;
      }
      observer?.disconnect();
      if (promptAnchorMeasureFrameRef.current !== null) {
        cancelAnimationFrame(promptAnchorMeasureFrameRef.current);
        promptAnchorMeasureFrameRef.current = null;
      }
    };
  }, [
    agentRunning,
    lastUserMsgRef,
    messages.length,
    promptAnchorActive,
    scrollContainerRef,
    scrollUserMsgToTop,
  ]);

  // Each streamed chunk StreamingReply commits, and the bubble coming and going.
  const updatePromptAnchor = useCallback(() => {
    promptAnchorUpdateRef.current?.();
  }, []);
  useLayoutEffect(updatePromptAnchor, [isStreaming, hasStreamingContent, updatePromptAnchor]);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const askUserQuestion = matchAskUserQuestion(extensionDialog, messages, getStreamingMessage());

  // The working indicator's elapsed clock: it runs only while a ChatLoading row
  // is on screen (never behind a streaming reply), resetting when a run starts.
  const showAgentWorking = (agentRunning || isCompacting) && !hasStreamingContent && Boolean(agentPhase || isCompacting);
  const showBashWorking = bashRunning && !pendingBash;
  const workingClockActive = showAgentWorking || showBashWorking;
  const [workingElapsedMs, setWorkingElapsedMs] = useState(0);
  useEffect(() => {
    if (!workingClockActive) return;
    const startedAt = Date.now();
    setWorkingElapsedMs(0);
    const tick = setInterval(() => setWorkingElapsedMs(Date.now() - startedAt), 100);
    return () => clearInterval(tick);
  }, [workingClockActive]);

  // The status card is a pure overlay (user ruling 2026-10-31: 悬浮就不该挤
  // 占对话): the column never shifts for it — only the first turn yields the
  // card's height (pt-14); its right clearance is 16px (the minimap rail
  // reservation died with the minimap, S1.2).
  const statusPanelActive = Boolean(session) && statusPanelModel.hasContent;
  const statusPanelResolvedVariant: StatusPanelVariant = statusPanelVariantOverride ?? "auto";

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      missingCwd={missingCwd}
      modelScopeWarnings={modelScopeWarnings}
      onModelChange={handleModelChange}
      modelSwitching={modelSwitching}
      defaultModel={defaultModel}
      onSetDefaultModel={handleSetDefaultModel}
      isCompacting={isCompacting}
      compactError={compactError}
      onDismissCompactError={dismissCompactError}
      compactResult={compactResult}
      thinkingLevel={thinkingLevel}
      isAutoThinkingSelection={isAutoThinkingSelection}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      savedDefaultThinkingLevel={savedDefaultThinkingLevel}
      onSetDefaultThinkingLevel={session || isNew ? handleSetDefaultThinkingLevel : undefined}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? newSessionDraftKey ?? undefined}
      cwd={session?.cwd ?? newSessionCwd}
      onAttachFiles={onAttachFiles}
      leadingAction={
        <BackgroundWorkBadges
          runningBashCount={statusWorks.length}
          runningSubagentCount={statusPanelSubagentRows.length}
          onOpen={handleOpenStatusPanel}
        />
      }
    />
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-text-muted">
        <span className="pi-loading-dot" aria-hidden="true" />
        <span className="pi-loading-shimmer">{t("chat.loadingSession")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="chat-content relative flex h-full min-w-0 flex-col overflow-hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      <div
        style={{
          position: "absolute",
          top: 12,
          left: 0,
          right: 0,
          zIndex: 40,
          display: "flex",
          // Toasts live in the top-right corner
          justifyContent: "flex-end",
          padding: `0 ${CHAT_COLUMN_PADDING}px`,
          pointerEvents: "none",
        }}
      >
        <NoticeShelf notices={notices} floating onPauseChange={setNoticePaused} />
      </div>

      <div
        ref={conversationLayoutRef}
        className="conversation-layout relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        {extensionDialog && !askUserQuestion && (
          <ExtensionDialog key={extensionDialog.id} request={extensionDialog} waitingCount={waitingExtensionDialogCount} onRespond={respondToExtensionUi} />
        )}
        {extensionCustomUi && (
          <ExtensionCustomPanel key={extensionCustomUi.id} request={extensionCustomUi} waitingCount={waitingExtensionCustomUiCount} onInput={sendExtensionCustomInput} />
        )}
        {/* The status card (C.1): first child of the conversation layout
            container, above the timeline; draft sessions render none. */}
        {!isEmptyNew && session && (
          <ConversationStatusPanel
            goal={goalProjection}
            todoItems={todoItems}
            works={statusWorks}
            subagents={statusPanelSubagentRows}
            parentSessionId={session.id}
            variantOverride={statusPanelVariantOverride}
            onVariantChange={setStatusPanelVariantOverride}
            terminalSectionOpen={terminalSectionOpen}
            onTerminalSectionOpenChange={setTerminalSectionOpen}
            agentSectionOpen={agentSectionOpen}
            onAgentSectionOpenChange={setAgentSectionOpen}
            onOpenBackgroundBash={onOpenBackgroundBash ? (work) => onOpenBackgroundBash(work.workId, work.title) : undefined}
            onOpenSubagentSession={onOpenSubagent ? (subagent) => onOpenSubagent(subagent.childSessionId, subagent.title) : undefined}
            onGoalCommand={handleGoalCommand}
          />
        )}
        {!isEmptyNew && <>
        <div
          ref={scrollContainerRef}
          // The message list is the one place long output has to be dragged
          // through, so it shows its scrollbar instead of hiding it (#788). A
          // stable gutter keeps the centred column from shifting when a short
          // session grows past one screen.
          className={`scrollbar-subtle min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-gutter:stable]${statusPanelActive ? " chat-scroll-status-clearance" : ""}`}
          style={{ visibility: pendingScrollRestore ? "hidden" : undefined }}
        >
          <div style={{ minWidth: 0 }}>
            <div ref={messageContentRef} onPointerUp={captureQuotedSelection} style={{ width: "100%", minWidth: 0, maxWidth: "var(--chat-content-adaptive-width, var(--chat-content-max-width, 820px))", margin: "0 auto", paddingInline: 24, transition: `max-width var(--chat-column-resize-transition, 150ms ease-out)` }}>
            {(() => {
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") { lastUserIdx = i; break; }
              }
              // Anchor for live-tail detection. A compaction summary or subagent
              // completion can sit after the last user message and own the
              // still-streaming segment. lastUserIdx stays the scroll target.
              let lastAnchorIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (isMessageGroupAnchor(messages[i])) { lastAnchorIdx = i; break; }
              }

              const attachVisibleRef = (idx: number) => (el: HTMLDivElement | null) => {
                if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
              };

              const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; showActions?: boolean; writtenFiles?: WrittenFile[]; turnDurationMs?: number; withNotices?: boolean; moveCacheMiss?: boolean } = {}): ReactNode => {
                const msg = options.messageOverride ?? messages[idx];
                if (isHiddenCustomMessage(msg)) return null;
                // pi's showCacheMissNotices (#1265): read from the stored message, not a turn view's copy.
                // R36: a turn's cache-miss warning renders after the query
                // instead of inside the stream — those renders opt in.
                const notices = options.withNotices === false
                  ? []
                  : getTranscriptNotices(messages[idx]).filter((notice) => !options.moveCacheMiss || notice.kind !== "cache_miss");
                const isVisible = isMessageGroupAnchor(msg) || msg.role === "assistant";
                const keyPrefix = options.keyPrefix ?? "message";
                // Not the entry id alone: a message sent or streamed in this run
                // gets its id only when the file is read again (#1184).
                const messageKey = messageKeys[idx];
                let showTimestamp = false;
                if (msg.role === "assistant") {
                  showTimestamp = true;
                  for (let j = idx + 1; j < messages.length; j++) {
                    const r = messages[j].role;
                    if (r === "user") break;
                    if (r === "assistant") { showTimestamp = false; break; }
                  }
                  // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                  if (showTimestamp && isStreaming && idx === messages.length - 1) {
                    showTimestamp = false;
                  }
                }
                if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
                const view = (
                  <MessageView
                    key={`${keyPrefix}-view-${messageKey}`}
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    onOpenSubagent={onOpenSubagent}
                    onOpenInjectedContext={onOpenInjectedContext}
                    entryId={entryIds[idx]}
                    searchBlock={entryIds[idx] === pendingSearchScroll?.entryId ? searchBlock : undefined}
                    onFork={bashRunning || isNew ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onEditContent={sessionBusy ? undefined : handleEditContent}
                    onSubmitEdit={handleSubmitEdit}
                    onCancelEdit={cancelEdit}
                    isEditing={editEntryId === entryIds[idx]}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    writtenFiles={options.writtenFiles}
                    turnDurationMs={options.turnDurationMs}
                    showActions={options.showActions}
                  />
                );
                const noticeLines = notices.length > 0 ? <TranscriptNoticeLines key={`${keyPrefix}-notices-${messageKey}`} notices={notices} /> : null;
                // One shape with or without notices, so lines arriving on a reload do not remount the view.
                if (!isVisible) return <Fragment key={`${keyPrefix}-${messageKey}`}>{view}{noticeLines}</Fragment>;
                // R46: only arrivals after the first paint (and outside a lazy-load
                // prepend window) carry the fade class; the latch keeps it stable.
                const fadeGate = entryFadeRef.current;
                const entryFades = fadeGate !== null && (fadeGate.animated.has(messageKey) || !fadeGate.exempt.has(messageKey));
                if (fadeGate !== null && entryFades) fadeGate.animated.add(messageKey);
                return (
                  <div key={`${keyPrefix}-${messageKey}`} data-entry-id={entryIds[idx]} className={entryFades ? "transcript-entry-in" : undefined} ref={options.attachRef === false ? undefined : attachVisibleRef(idx)}>
                    {view}
                    {noticeLines}
                  </div>
                );
              };

              const rendered: ReactNode[] = [];
              for (let idx = 0; idx < messages.length;) {
                const msg = messages[idx];
                const hasAnchor = isMessageGroupAnchor(msg);
                if (!hasAnchor && idx !== 0) {
                  rendered.push(renderMessage(idx));
                  idx += 1;
                  continue;
                }

                // The first history page starts at a fixed entry count, so a turn
                // longer than that page begins without its anchor. Group the
                // leading segment anyway instead of flattening the whole turn.
                const userIdx = hasAnchor ? idx : -1;
                const groupStartIdx = hasAnchor ? idx : 0;
                let endIdx = idx + 1;
                while (endIdx < messages.length && !isMessageGroupAnchor(messages[endIdx])) endIdx += 1;

                const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

                // R46: a turn still under way folds like a finished one. The
                // raw-message path it used to take rendered every committed
                // step as its own card with full message gaps, so the live
                // process read as loose rows that only tightened after the
                // turn ended. A turn with no final answer yet (none committed,
                // or the streaming reply still in the store) groups its whole
                // range as process and reveals the fold while it runs; the
                // streaming reply renders under it, outside the fold.
                const turnUnderWay = (sessionBusy || isStreaming) && endIdx === messages.length && userIdx === lastAnchorIdx;
                const hasCommittedAnswer = finalAssistantIdx !== -1;
                if (!hasAnchor && (!hasCommittedAnswer || turnUnderWay)) {
                  for (let renderIdx = groupStartIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }
                // endIdx is an EXCLUSIVE bound (it can be messages.length); the
                // process loop is inclusive, so the no-answer bound steps back.
                const processEndIdx = hasCommittedAnswer ? finalAssistantIdx : endIdx - 1;

                if (hasAnchor) {
                  rendered.push(renderMessage(userIdx));
                  const turnCacheMisses = collectTurnCacheMissNotices(messages, userIdx, endIdx);
                  if (turnCacheMisses.length > 0) {
                    rendered.push(
                      <div key={`turn-cache-miss-${messageKeys[userIdx]}`} className="turn-cache-miss-notice">
                        <TranscriptNoticeLines notices={turnCacheMisses} />
                      </div>,
                    );
                  }
                }

                // A leading segment without its anchor has no start time, and neither has the bubble a
                // send shows at once: it carries the browser's clock, not pi's, until the reload after
                // the run brings the session file's entry (the only kind with an entry id).
                const turnDurationMs = hasAnchor && entryIds[userIdx] ? getTurnDurationMs(messages, userIdx, endIdx) : undefined;

                const finalViews = hasCommittedAnswer
                  ? getFinalAnswerViews(finalAnswerViewCache, messages[finalAssistantIdx] as AssistantMessage)
                  : null;
                const finalAnswerMessage = finalViews?.answer;

                const processViews: Array<{ family: ToolCallFamily | null; groupKey: string; names: string[]; nodes: ReactNode[] }> = [];
                // processViews also holds the notice lines of steps that show nothing else.
                let processMessageCount = 0;
                let processToolCount = 0;
                let revealProcess = false;

                for (let processIdx = userIdx + 1; processIdx <= processEndIdx; processIdx++) {
                  const processMessage = messages[processIdx];
                  if (processMessage.role === "custom") {
                    // Not counted either: a turn whose only extra is a hidden message has no process details.
                    if (isHiddenCustomMessage(processMessage)) continue;
                    revealProcess ||= Boolean(pendingSearchScroll && pendingSearchScroll.entryId === entryIds[processIdx]);
                    processMessageCount += 1;
                    processViews.push({ family: null, groupKey: "", names: [], nodes: [renderMessage(processIdx, { attachRef: false, keyPrefix: "process" })] });
                    continue;
                  }
                  if (processMessage.role !== "assistant") continue;
                  const message = processIdx === finalAssistantIdx && finalViews ? finalViews.process : processMessage;
                  // The final message's notices go under its answer when it has one.
                  const withNotices = processIdx !== finalAssistantIdx || !finalAnswerMessage;
                  const blocks = getDisplayableAssistantBlocks(message);
                  if (blocks.length === 0) {
                    const notices = withNotices ? getTranscriptNotices(processMessage) : [];
                    if (notices.length > 0) processViews.push({ family: null, groupKey: "", names: [], nodes: [<TranscriptNoticeLines key={`process-notices-${messageKeys[processIdx]}`} notices={notices} />] });
                    continue;
                  }
                  processToolCount += countToolCallBlocks(blocks);
                  processMessageCount += 1;
                  revealProcess ||= Boolean(pendingSearchScroll && entryIds[processIdx] === pendingSearchScroll.entryId && (!searchBlock || blocks.includes(searchBlock)));
                  const view = renderMessage(processIdx, {
                    attachRef: false,
                    keyPrefix: "process",
                    messageOverride: message,
                    showTimestamp: false,
                    // ZCode hides assistant actions on every non-latest
                    // segment; intermediate replies take no row (and no height).
                    showActions: false,
                    withNotices,
                    moveCacheMiss: true,
                  });
                  // ZCode's consecutive-call merge (executeGroup & co): pi
                  // stores each call as its own entry, so the run is rebuilt
                  // here — only messages that are a SINGLE tool call with no
                  // narration fold together. Text between edits ("第一改——…")
                  // is an interleaved step, not a consecutive call: it must
                  // break the run (user order 2026-11-01: 编辑不是连续调用，
                  // 不应当折叠).
                  const callBlocks = blocks.filter((block): block is ToolCallContent => block.type === "toolCall");
                  const runFamily = blocks.length === 1 && callBlocks.length === 1
                    ? toolCallFamily(callBlocks[0].toolName)
                    : null;
                  const prev = processViews.at(-1);
                  if (runFamily !== null && prev?.family === runFamily) {
                    prev.names.push(callBlocks[0].toolName);
                    prev.nodes.push(view);
                  } else {
                    processViews.push({
                      family: runFamily,
                      groupKey: `group:${runFamily !== null ? callBlocks[0].toolCallId : ""}`,
                      names: runFamily !== null ? [callBlocks[0].toolName] : [],
                      nodes: [view],
                    });
                  }
                }

                // A run of ≥2 same-family calls renders as its group card;
                // everything else (single calls, text, notices) stays itself.
                const processNodes = processViews.map((entry, index) =>
                  entry.family !== null && entry.names.length > 1 ? (
                    <ToolCallGroupCard key={`pg-${index}-${entry.groupKey}`} family={entry.family} label={t(FAMILY_KIND_KEY[entry.family])} counts={countToolCallRun(entry.family, entry.names)} groupKey={entry.groupKey}>
                      {entry.nodes}
                    </ToolCallGroupCard>
                  ) : (
                    <Fragment key={`pg-${index}`}>{entry.nodes}</Fragment>
                  ),
                );

                // Only notice lines, from steps that show nothing else: no fold for them.
                revealProcess ||= turnUnderWay;
                if (processMessageCount === 0) rendered.push(...processNodes);
                else if (processViews.length > 0) {
                  const answered = finalAnswerMessage !== undefined && collapsesProcessDetails(finalAnswerMessage ?? null);
                  const processCacheMisses = summarizeCacheMisses(messages.slice(userIdx + 1, hasCommittedAnswer ? finalAssistantIdx : endIdx));
                  rendered.push(
                    <div
                      key={`process-group-${messageKeys[groupStartIdx]}`}
                    >
                      {/* Re-key on answer availability: useState reads defaultExpanded only
                          on mount, so a turn first rendered without an answer (expanded)
                          would otherwise stay open once its answer shows up, e.g. when
                          switching between an answered and an unanswered leaf of the same
                          turn. Manual toggles survive every other re-render. */}
                      <ProcessDetailsGroup key={answered ? "answered" : "unanswered"} messageCount={processMessageCount} toolCallCount={processToolCount} durationMs={turnDurationMs} cacheMisses={processCacheMisses} defaultExpanded={!answered} reveal={revealProcess} t={t}>
                        {processNodes}
                      </ProcessDetailsGroup>
                    </div>,
                  );
                }

                if (hasCommittedAnswer && finalAnswerMessage) {
                  // Each tool call is stored as its own assistant entry, so the
                  // final answer alone carries no record of what the turn wrote.
                  // Gather the turn's assistant blocks and derive the file list
                  // from the write/edit calls among them.
                  const turnContent: AssistantContentBlock[] = [];
                  for (let i = userIdx + 1; i <= finalAssistantIdx; i++) {
                    const m = messages[i];
                    if (m?.role === "assistant") {
                      for (const b of (m as AssistantMessage).content ?? []) turnContent.push(b);
                    }
                  }
                  const writtenFiles = keepWrittenFiles(finalViews, extractTurnWrittenFiles(turnContent, toolResultsMap, messageCwd));
                  rendered.push(renderMessage(finalAssistantIdx, {
                    messageOverride: finalAnswerMessage,
                    writtenFiles,
                    // Without process details the turn's time goes under the answer.
                    turnDurationMs: processViews.length === 0 ? turnDurationMs : undefined,
                    // R36: cache-miss warnings live after the query, not here.
                    moveCacheMiss: true,
                  }));
                }
                for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                  rendered.push(renderMessage(renderIdx));
                }
                idx = endIdx;
              }
              const { startIndex } = getVisibleRenderWindow(rendered.length, visibleCount);
              const hasMore = startIndex > 0 || hasEarlierMessages;
              return (
                <>
                  {hasMore && (
                     <div ref={setSentinel} className="py-3 text-center text-text-muted" style={{ fontSize: "var(--font-size-xs)" }}>
                       {t("chat.loadEarlier")}
                    </div>
                  )}
                  {rendered.slice(startIndex)}
                </>
              );
            })()}
            {isStreaming && hasStreamingContent && (
              <StreamingReply store={streamingStore} onCommit={updatePromptAnchor} toolResults={toolResultsMap} modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} onStreamRate={onStreamRate} />
            )}

            {showAgentWorking && (
              <div className="break-words py-2">
                <ChatLoadingRow
                  label={phaseLabel(agentPhase, t, isCompacting, (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0)) ?? ""}
                  elapsedMs={workingElapsedMs}
                />
              </div>
            )}

            {showBashWorking && (
              <div className="py-2">
                <ChatLoadingRow slow label={t("chat.runningCommand")} elapsedMs={workingElapsedMs} />
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                onOpenSubagent={onOpenSubagent}
              />
            )}

            <div ref={promptAnchorSpacerRef} aria-hidden="true" />
            </div>
          </div>
        </div>
        {pendingScrollRestore ? null : (
          <ConversationTurnNavigator
            items={turnNavigatorItems}
            layoutRef={conversationLayoutRef}
            scrollContainerRef={scrollContainerRef}
            onJumpToQuery={jumpToQuery}
          />
        )}
        </>}
      </div>

      {quoteSelectionEnabled && quotedSelection && createPortal(
        <div
          ref={quotePopoverRef}
          role={quoteInputOpen ? "dialog" : "toolbar"}
          aria-label={t(quoteInputOpen ? "chat.newQuoteChat" : "chat.askSelection")}
          className="quote-popover"
          style={{
            position: "fixed",
            top: quotedSelection.top,
            left: quotedSelection.left,
            zIndex: 260,
            display: "flex",
            flexWrap: "wrap",
            gap: 3,
            width: quoteInputOpen ? "min(420px, calc(100vw - 16px))" : undefined,
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "calc(var(--app-viewport-height, 100dvh) - 16px)",
            overflowY: "auto",
            padding: quoteInputOpen ? 12 : 3,
            border: "1px solid var(--border)",
            background: "var(--bg)",
          }}
        >
          {quoteInputOpen ? (
            <fieldset
              disabled={quoteSubmitting}
              aria-busy={quoteSubmitting}
              style={{ width: "100%", minWidth: 0, margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 10 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: "var(--font-size-sm)", fontWeight: 600 }}>{t("chat.askInNewChat")}</span>
                <button type="button" className="file-viewer-icon-button" title={t("i18n.close")} aria-label={t("i18n.close")} disabled={quoteSubmitting} onClick={closeQuotedSelection} style={{ border: "none" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                </button>
              </div>
              <ChatInput
                ref={quoteChatInputRef}
                compact
                onSend={askSelectionInNewChat}
                onAbort={closeQuotedSelection}
                isStreaming={false}
              />
              {quoteError && <div role="alert" style={{ color: "#dc2626", fontSize: "var(--font-size-sm)", overflowWrap: "anywhere" }}>{quoteError}</div>}
            </fieldset>
          ) : <>
          <button
            type="button"
            className="file-viewer-icon-button"
            title={t("chat.askInCurrent")}
            aria-label={t("chat.askInCurrent")}
            onPointerDown={(event) => event.preventDefault()}
            onClick={askSelectionHere}
            style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: "var(--font-size-sm)", fontWeight: 500 }}
          >
            <span aria-hidden="true" style={{ fontSize: "var(--font-size-base)" }}>@</span>
            <span>{t("chat.askInCurrent")}</span>
          </button>
          {onAskInNewChat && quotedSelection.sourceEntryId && !bashRunning && (
            <button
              type="button"
              className="file-viewer-icon-button"
              title={t("chat.askInNewChat")}
              aria-label={t("chat.askInNewChat")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => { setQuoteInputOpen(true); window.getSelection()?.removeAllRanges(); }}
              style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: "var(--font-size-sm)", fontWeight: 500 }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 3v12M18 9a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
              </svg>
              <span>{t("chat.askInNewChat")}</span>
            </button>
          )}
          </>}
        </div>,
        document.body,
      )}

      <div className="composer-dock relative flex min-h-0 flex-col" style={{ paddingBottom: isEmptyNew ? 8 : 16 }}>
        {!isEmptyNew && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: 0,
              display: "flex",
              justifyContent: "center",
              paddingBottom: 10,
              pointerEvents: "none",
              zIndex: 20,
            }}
          >
            <button
              type="button"
              className={`chat-scroll-to-bottom${showScrollToBottom && !pendingScrollRestore ? " is-visible" : ""}`}
              title={t("chat.scrollToLatest")}
              aria-label={t("chat.scrollToLatest")}
              onClick={() => scrollToBottom("smooth")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
            </button>
          </div>
        )}
        {/* The brand (the logo, "Neko-Pi" and its versions line), then the
            project/worktree row right above the composer, all on the
            composer's left edge (.new-session-brand, .new-session-meta and
            .new-session-context in app/globals.css; the side padding and
            width are inline here). */}
        {isEmptyNew && (
          <div className="new-session-hero" style={{ paddingLeft: 16, paddingRight: isMobile ? 16 : 52 }}>
            <div className="new-session-hero-inner" style={{ maxWidth: "var(--chat-content-adaptive-width, var(--chat-content-max-width, 820px))", transition: "max-width var(--chat-column-resize-transition, 150ms ease-out)" }}>
              <div className="new-session-brand">
                <Image src="/icons/apple-touch-icon.png" width={40} height={40} alt="" priority className="new-session-logo" />
                <div className="new-session-brand-text">
                  <span className="new-session-brand-name">Neko-Pi</span>
                  <span className="new-session-meta">
                    <span>web v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                    <NewSessionUpdateLink label={(version) => t("appUpdate.releaseNotes", { version })} />
                    <span aria-hidden="true">·</span>
                    <span className="new-session-meta-pi">pi v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span>
                  </span>
                </div>
              </div>
              {newSessionContextBar}
            </div>
          </div>
        )}
        {extensionDialog?.method === "select" && askUserQuestion && (
          <div className="ask-user-dock-shell">
            <AskUserDock key={extensionDialog.id} request={extensionDialog} question={askUserQuestion} waitingCount={waitingExtensionDialogCount} onRespond={respondToExtensionUi} />
          </div>
        )}
        {chatInputElement}
        <ExtensionStatusBar
          statuses={barStatuses}
          widgets={extensionWidgets}
          onCommand={handleSend}
          commandsDisabled={sessionBusy}
        />
      </div>
      {isEmptyNew && <div className="min-h-0 flex-1" />}
    </div>
  );
}

// The reply being streamed: the one part of the chat a chunk re-renders.
const StreamingReply = memo(function StreamingReply({ store, onCommit, toolResults, modelNames, cwd, onOpenFile, onOpenSubagent, onStreamRate }: {
  store: StreamingStore;
  /** Runs after each chunk is in the DOM. */
  onCommit: () => void;
  toolResults: Map<string, ToolResultMessage>;
  modelNames: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  onStreamRate?: (rate: number | null) => void;
}) {
  const message = useStreamingSelector(store, selectStreamingMessage);
  useLayoutEffect(onCommit, [message, onCommit]);
  if (!message) return null;
  return <MessageView message={message} toolResults={toolResults} isStreaming modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} onStreamRate={onStreamRate} />;
});

// A one-line notice is exactly as tall as its entrance animation pins it, and
// its line sits dead centre: the two 1px borders, a 21px line box (14px at
// line-height 1.5) and this padding twice add up to 60px. Letting the card's
// min-height take the leftover instead leaves the top-aligned text 4.5px above
// the centre, since the rest of the leftover stays under it.
const NOTICE_MIN_HEIGHT_PX = 60;
const NOTICE_LINE_BOX_PX = 21;
const NOTICE_TEXT_PADDING_Y_PX = (NOTICE_MIN_HEIGHT_PX - 2 - NOTICE_LINE_BOX_PX) / 2;
// Toast 整体高度上限；文本区高度上限 = 整体上限 - 上下边框（全局 box-sizing: border-box，
// 文本区的 max-height 已包含它自己的上下 padding，不能再减一次）
const NOTICE_MAX_HEIGHT_PX = 500;
const NOTICE_TEXT_MAX_HEIGHT_PX = NOTICE_MAX_HEIGHT_PX - 2;

function NoticeShelf({ notices, floating = false, onPauseChange }: { notices: NoticeItem[]; floating?: boolean; onPauseChange?: (id: string | null) => void }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // Right-anchored: every toast's right edge aligns here, widths extend leftward
        alignItems: "flex-end",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            onMouseEnter={() => onPauseChange?.(notice.id)}
            onMouseLeave={(event) => {
              if (!event.currentTarget.contains(document.activeElement)) onPauseChange?.(null);
            }}
            onFocus={() => onPauseChange?.(notice.id)}
            onBlur={(event) => {
              if (!event.currentTarget.matches(":hover")) onPauseChange?.(null);
            }}
            style={{
              display: "flex",
              // Top-align children so the type dot sits by the first line on multi-line toasts
              alignItems: "flex-start",
              gap: 10,
              minHeight: NOTICE_MIN_HEIGHT_PX,
              height: "auto",
              // 整体高度上限：超出后由文本区内部滚动承担（见下方 span 的 overflowY），
              // 容器自身保持 hidden，小圆点固定在顶部不随文本滚动
              maxHeight: NOTICE_MAX_HEIGHT_PX,
              // The floating wrapper is pointerEvents:"none" (click-through by design),
              // so the toast itself must opt back into interactivity or hover events never reach it
              pointerEvents: "auto",
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: "var(--radius-2xl)",
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating ? "var(--shadow-overlay)" : "var(--shadow-composer-soft)",
              fontSize: "var(--font-size-base)",
              lineHeight: 1.5,
              transformOrigin: "top right",
              // Use backwards fill for the entrance animation so height styles return to
              // inline styles once it finishes; otherwise the keyframe's fixed 60px would
              // stick around in fill mode and permanently clamp the expanded toast
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out backwards",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                // Align with the optical center of the first text line: the text's
                // vertical padding + (21px line box - 7px dot) / 2
                marginTop: NOTICE_TEXT_PADDING_Y_PX + 7,
              }}
            />
            {/* Full text by default: pre-line preserves \n (nowrap/normal collapse
                newlines into spaces) and long lines wrap instead of truncating;
                content taller than the cap scrolls inside the text area */}
            <span
              tabIndex={0}
              style={{ padding: `${NOTICE_TEXT_PADDING_Y_PX}px 0`, minWidth: 0, maxWidth: "100%", maxHeight: NOTICE_TEXT_MAX_HEIGHT_PX, overflowY: "auto", scrollbarWidth: "thin", whiteSpace: "pre-line", wordBreak: "break-word" }}
            >
              {splitNoticeText(notice.message).map((part, partIndex) => part.kind === "art" ? (
                // A terminal QR code or bar (#755): every space kept, rows touching, and a
                // font stack whose first font has the blocks too (the bundled Noto subset
                // has none, so spaces and blocks would come from fonts of different widths).
                <span
                  key={partIndex}
                  style={{
                    display: "inline-block",
                    verticalAlign: "top",
                    maxWidth: "100%",
                    overflowX: "auto",
                    whiteSpace: "pre",
                    fontFamily: "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
                    lineHeight: 1,
                    color: "var(--text)",
                  }}
                >
                  {part.text}
                </span>
              ) : part.text)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function getExtensionDialogSummary(request: ExtensionDialogRequest): string | undefined {
  if (request.method === "select" && request.options.length > 0) return request.options[0];
  if (request.method === "confirm") {
    const firstLine = request.message.split("\n").find((line) => line.trim());
    return firstLine?.trim();
  }
  return undefined;
}

/** "+N more": requests of the same kind queued behind the one on screen, each shown once that one closes. */
function ExtensionWaitingCount({ count }: { count: number }) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return (
    <span style={{ fontSize: "var(--font-size-sm)", fontWeight: 650, color: "var(--accent)", whiteSpace: "nowrap", flexShrink: 0 }}>
      {t("chat.extensionMoreWaiting", { count })}
    </span>
  );
}

/** Corner brackets pointing outward; when expanded they point inward (restore). */
function ExtensionSizeIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {expanded
        ? <path d="M3.5 1v2.5H1M6.5 1v2.5H9M6.5 9v-2.5H9M3.5 9v-2.5H1" />
        : <path d="M1 3.5V1h2.5M6.5 1H9v2.5M9 6.5V9H6.5M3.5 9H1V6.5" />}
    </svg>
  );
}

function ExtensionDialog({
  request,
  waitingCount,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  /** Further dialogs queued behind this one; each opens after this one is answered. */
  waitingCount: number;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [collapsed, setCollapsed] = useState(false);
  // Dialogs open at the historical width and grow only when their own content cannot
  // fit (a code block or table that would scroll sideways), so no extension has to ask
  // for room. The maximize button is the user's own override for this dialog (#947).
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [fitWidth, setFitWidth] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const toggleFull = useCallback(() => setFull((prev) => !prev), []);
  const [now, setNow] = useState(() => Date.now());
  const focusFirstOption = useCallback((element: HTMLDivElement | null) => element?.focus(), []);
  const summary = getExtensionDialogSummary(request);
  const remainingSeconds = request.expiresAt === undefined
    ? null
    : Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  useLayoutEffect(() => {
    if (collapsed) return;
    const dialog = dialogRef.current;
    const body = bodyRef.current;
    if (!dialog || !body) return;
    let disposed = false;
    const fit = () => {
      if (disposed) return;
      const blocks = body.querySelectorAll<HTMLElement>("pre, .markdown-table-wrap");
      if (blocks.length === 0) return;
      // Code fences wrap their long lines; measured unwrapped, they still widen
      // the dialog as far as the screen allows and wrap only past that. The
      // class is an attribute change, which the observer below does not watch.
      body.classList.add("extension-dialog-measuring");
      const overflows = Array.from(blocks, (block) => block.scrollWidth - block.clientWidth);
      body.classList.remove("extension-dialog-measuring");
      const needed = fitExtensionDialogWidth(dialog.offsetWidth, overflows);
      // Only ever grow: shrinking again would make the dialog jump while it is read.
      if (needed !== null) setFitWidth((prev) => (prev !== null && prev >= needed ? prev : needed));
    };
    fit();
    // Highlighted code replaces its plain fallback after the first paint, and a web
    // font can change glyph widths once it arrives.
    const mutations = new MutationObserver(fit);
    mutations.observe(body, { childList: true, subtree: true, characterData: true });
    void document.fonts?.ready.then(fit);
    return () => {
      disposed = true;
      mutations.disconnect();
    };
  }, [collapsed]);

  useEffect(() => {
    if (request.expiresAt === undefined) return;
    // The server closes expired requests via extension_ui_closed.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);

  const countdown = remainingSeconds !== null && (
    <span style={{ fontSize: "var(--font-size-sm)", color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
      {t("chat.extensionExpiresIn", { seconds: remainingSeconds })}
    </span>
  );

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onRespond(request, { cancelled: true });
      }}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: collapsed ? "flex-start" : "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "none",
      }}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(560px, 100%)",
            width: "100%",
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: "var(--font-size-sm)", fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: "var(--font-size-caption)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {request.title}
          </span>
          {summary && (
            <span style={{ fontSize: "var(--font-size-sm)", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          <ExtensionWaitingCount count={waitingCount} />
          {countdown}
          <span style={{ fontSize: "var(--font-size-sm)", color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={request.title}
        style={{
          pointerEvents: "auto",
          // "Full" fills the content region above the composer: the overlay is inset:0 with
          // 20px padding, so 100% keeps that breathing room without covering the input.
          width: full ? "100%" : `min(${fitWidth ?? EXTENSION_DIALOG_BASE_WIDTH}px, 100%)`,
          maxHeight: full ? "100%" : "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ flexShrink: 1, minHeight: 0, display: "flex", alignItems: "flex-start", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)", maxHeight: "50vh", overflowY: "auto" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Pi's TUI shows the title verbatim, newlines included; select/input have no
                separate message field, so extensions put multi-line text here. */}
            <div style={{ color: "var(--text)", fontSize: "var(--font-size-base)", fontWeight: 650, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{request.title}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 3, color: "var(--text-dim)", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-mono)" }}>
              <span>{t("chat.extensionRequest")}</span>
              <ExtensionWaitingCount count={waitingCount} />
              {countdown}
            </div>
          </div>
          <button
            type="button"
            onClick={toggleFull}
            title={full ? t("chat.extensionRestoreSize") : t("chat.extensionMaximize")}
            aria-label={full ? t("chat.extensionRestoreSize") : t("chat.extensionMaximize")}
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <ExtensionSizeIcon expanded={full} />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-expanded={true}
            title={t("chat.extensionCollapse")}
            aria-label={t("chat.extensionCollapse")}
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>
        </div>

        <div
          ref={bodyRef}
          style={{
            padding: 14,
            flex: "1 1 auto", minHeight: 0, overflowY: "auto",
          }}
        >
          {request.method === "confirm" && (
            <MarkdownBody>{request.message}</MarkdownBody>
          )}
          {request.method === "select" && (
            <div
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-extension-option]"));
                const index = buttons.indexOf(event.target as HTMLElement);
                if (index < 0) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0
                  : event.key === "End" ? buttons.length - 1
                  : (index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
                buttons[next].focus({ preventScroll: true });
                buttons[next].scrollIntoView({ block: "nearest" });
              }}
              style={{ display: "grid", gap: 8 }}
            >
              {request.options.map((option, index) => (
                <div
                  key={option}
                  role="button"
                  tabIndex={0}
                  data-extension-option
                  aria-label={option}
                  ref={index === 0 ? focusFirstOption : undefined}
                  onClick={() => onRespond(request, { value: option })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onRespond(request, { value: option });
                  }}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: "var(--font-size-caption)",
                    overflowWrap: "anywhere",
                    // Match the scroller's padding so keyboard navigation never parks the
                    // option flush against the edge, where whole-pixel scroll snapping and
                    // overflow clipping cut off its focus ring.
                    scrollMargin: 14,
                  }}
                >
                  <div inert>
                    <MarkdownBody>{option}</MarkdownBody>
                  </div>
                </div>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) submitValue();
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: "var(--font-size-caption)",
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.nativeEvent.isComposing) submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: "var(--font-size-caption)",
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            autoFocus={request.method === "confirm" || (request.method === "select" && request.options.length === 0)}
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
      )}
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function ExtensionCustomPanel({
  request,
  waitingCount,
  onInput,
}: {
  request: ExtensionCustomRequest;
  /** Further custom panels queued behind this one; each opens after this one closes. */
  waitingCount: number;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const displayLines = normalizeCustomPanelLines(request.lines);
  const summary = displayLines.find((line) => line.trim())?.trim();

  useEffect(() => {
    if (!collapsed) inputRef.current?.focus();
  }, [collapsed]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: collapsed ? "flex-start" : "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "none",
      }}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(920px, 100%)",
            width: "100%",
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: "var(--font-size-sm)", fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: "var(--font-size-caption)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {t("chat.extensionPanel")}
          </span>
          {summary && (
            <span style={{ fontSize: "var(--font-size-sm)", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          <ExtensionWaitingCount count={waitingCount} />
          <span style={{ fontSize: "var(--font-size-sm)", color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        role="dialog"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          pointerEvents: "auto",
          position: "relative",
          // The extension already wrapped its lines to the width it asked for; show them
          // whole when that is wider than the usual 920px instead of scrolling sideways.
          width: "max-content",
          minWidth: "min(920px, 100%)",
          maxWidth: "100%",
          maxHeight: "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: "var(--font-size-caption)", fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ExtensionWaitingCount count={waitingCount} />
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-expanded={true}
              title={t("chat.extensionCollapse")}
              aria-label={t("chat.extensionCollapse")}
              style={{
                display: "grid",
                placeItems: "center",
                width: 28,
                height: 28,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
            <button
              onClick={() => onInput(request, "\x03")}
              style={{
                padding: "5px 9px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: "var(--font-size-sm)",
              }}
            >
               {t("chat.close")}
            </button>
          </div>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            minHeight: 0,
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-caption)",
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          <AnsiText text={displayLines.join("\n")} />
        </pre>
      </div>
      )}
    </div>
  );
}
