"use client";

import { toolIconFor } from "./tool-icons";

import React, { memo, useRef, useState, useCallback, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, KeyboardEvent, type ReactNode } from "react";
import type { BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import type { SkillsResponse } from "@/lib/api-types";
import type { TextContent, UserMessage } from "@/lib/types";
import {
  clearDraft,
  getDraft,
  mergeRestoredSubmissionDraft,
  mergeRestoredSubmissionText,
  rekeyDraft as rekeyStoredDraft,
  setDraft,
  type ChatDraftImage,
} from "@/lib/draft-store";
import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "@/lib/image-attachments";
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { getMarkdownListContinuation } from "@/lib/markdown-list-continuation";
import { isBareMcpCommand, isBuiltinMcpCommand } from "@/lib/mcp-command";
import { skillCommandToSessionText } from "@/lib/skill-command";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { ImagePreview } from "./ImagePreview";
import { DismissButton } from "./DismissButton";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useEnterSendMode } from "@/hooks/useEnterSendMode";
import { useI18n } from "@/hooks/useI18n";
import { useChatAppearance } from "@/hooks/useChatAppearance";
import { useFontPreferences } from "@/hooks/useFontPreferences";
import { SelectorRow } from "./SelectorRow";
import { ModelSelector, type ModelSelectorOption } from "./ModelSelector";

export { filterModelOptions } from "./ModelSelector";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => void;
  isStreaming: boolean;
  /** Text-only composer without the session controls or outer spacing. */
  compact?: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; input?: string[] }[];
  modelError?: string | null;
  /** The session's folder, when it no longer exists (moved or renamed): said instead of a model error (#1422). */
  missingCwd?: string | null;
  /** Diagnostics from resolving `enabledModels`, e.g. a pattern that matched nothing. */
  modelScopeWarnings?: string[];
  onModelChange?: (provider: string, modelId: string) => void;
  modelSwitching?: boolean;
  /** The model new sessions start with, starred in the model selector. */
  defaultModel?: { provider: string; modelId: string } | null;
  /** Saves a model as the default for new sessions and selects it here. */
  onSetDefaultModel?: (provider: string, modelId: string) => void;
  isCompacting?: boolean;
  compactError?: string | null;
  onDismissCompactError?: () => void;
  compactResult?: CompactResultInfo | null;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** New session has not committed a thinking level; the button still shows the resolved default. */
  isAutoThinkingSelection?: boolean;
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  /** `defaultThinkingLevel` saved in settings, starred in the reasoning menu. */
  savedDefaultThinkingLevel?: string | null;
  /** Saves a reasoning level as the default for new sessions and selects it here. */
  onSetDefaultThinkingLevel?: (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  inputHistory?: string[];
  onRecallQueue?: () => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
  /** Files picked with the attach button, handled like files dropped onto the chat. Without it the button takes images only. */
  onAttachFiles?: (files: File[]) => void;
  /** Leading-cluster slot (Wave N A.1): the composer's background-work badge
   * rides here, after the model selector — ZCode's leadingActionsNode position. */
  leadingAction?: ReactNode;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  replaceMessage: (message: UserMessage) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
  rekeyDraft: (previousKey: string, nextKey: string) => void;
  restoreSubmission: (text: string, images?: ChatDraftImage[], targetDraftKey?: string) => void;
  focus: () => void;
}

const COMPOSITION_END_ENTER_GRACE_MS = 100;
const TEXT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const ANCHORED_MENU_GAP = 8;

export function getUpwardMenuMaxHeight(menuBottom: number, visibleTop: number, gap = ANCHORED_MENU_GAP): number {
  return Math.max(0, Math.floor(menuBottom - visibleTop - gap));
}

export function cycleListIndex(index: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}

/**
 * The item one arrow-key step away in a rendered grid.
 *
 * Left/right walk the row; up/down jump to the card above/below, judged by the
 * rendered centres, so a multi-column menu moves in two dimensions instead of
 * walking its DOM order sideways. Without a laid-out neighbour (first or last
 * row, or a menu that is not measured yet) it falls back to ±1.
 */
export function nextIndexInDirection(
  currentIndex: number,
  count: number,
  nodes: ReadonlyArray<{ getBoundingClientRect(): DOMRect } | null>,
  direction: "up" | "down" | "left" | "right",
): number {
  const lastIndex = count - 1;
  if (lastIndex < 0) return 0;

  if (direction === "left") return Math.max(0, currentIndex - 1);
  if (direction === "right") return Math.min(lastIndex, currentIndex + 1);

  const fallback = direction === "down"
    ? Math.min(lastIndex, currentIndex + 1)
    : Math.max(0, currentIndex - 1);
  const currentNode = nodes[currentIndex];
  if (!currentNode) return fallback;

  const currentRect = currentNode.getBoundingClientRect();
  const currentX = currentRect.left + currentRect.width / 2;
  const currentY = currentRect.top + currentRect.height / 2;
  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let index = 0; index <= lastIndex; index += 1) {
    if (index === currentIndex) continue;
    const node = nodes[index];
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    const candidateY = rect.top + rect.height / 2;
    const verticalDelta = candidateY - currentY;
    // Same row: not above/below, whichever way we are going.
    if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

    const candidateX = rect.left + rect.width / 2;
    const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
    if (score < bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  return bestIndex >= 0 ? bestIndex : fallback;
}

// Plain replacement for when execCommand is unavailable or refuses: no undo
// entry, but the mention still lands and React's onChange still fires.
function setTextareaRange(textarea: HTMLTextAreaElement, start: number, end: number, text: string): void {
  textarea.setRangeText(text, start, end, "end");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// Replace [start, end) with `text` as native edits so the textarea's own
// undo/redo history records them. With a collapsed caret inside the range the
// typed prefix is deleted and the tail forward-deleted, so undo returns to
// what the user had typed.
export function replaceTextareaRange(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
  cursorOffset = text.length,
): void {
  const selectionStart = textarea.selectionStart;
  const selectionEnd = textarea.selectionEnd;
  textarea.focus();

  if (selectionStart === selectionEnd && start <= selectionStart && end >= selectionEnd) {
    const finalLength = textarea.value.length - (end - start) + text.length;
    for (let edits = selectionStart - start; edits > 0 && textarea.selectionStart > start; edits--) {
      if (!document.execCommand("delete")) break;
    }
    if (document.execCommand("insertText", false, text)) {
      for (let edits = end - selectionEnd; edits > 0 && textarea.value.length > finalLength; edits--) {
        if (!document.execCommand("forwardDelete")) break;
      }
    } else {
      // Whatever prefix the deletes left is still in [start, caret); the tail is untouched.
      setTextareaRange(textarea, start, textarea.selectionStart + (end - selectionEnd), text);
    }
  } else {
    textarea.setSelectionRange(start, end);
    if (!document.execCommand("insertText", false, text)) setTextareaRange(textarea, start, end, text);
  }

  if (cursorOffset !== text.length) {
    textarea.setSelectionRange(start + cursorOffset, start + cursorOffset);
  }
}

export function replaceLinksWithMarkdown(
  text: string,
  links: Iterable<{ label: string; href: string; occurrence: number }>,
): string | null {
  let result = "";
  let searchFrom = 0;
  let replaced = false;

  for (const { label, href, occurrence } of links) {
    if (!label || !href) continue;
    let index = 0;
    for (let match = 0; match <= occurrence; match++) {
      index = text.indexOf(label, match ? index + label.length : 0);
      if (index < 0) break;
    }
    if (index < searchFrom) continue;
    const escapedLabel = label.replace(/([\\[\]])/g, "\\$1");
    const escapedHref = href.replace(/([\\()])/g, "\\$1");
    result += `${text.slice(searchFrom, index)}[${escapedLabel}](${escapedHref})`;
    searchFrom = index + label.length;
    replaced = true;
  }

  return replaced ? result + text.slice(searchFrom) : null;
}

/**
 * The composer's auto-grow step: fit the text to 200 px, then let a scrollbar
 * appear only when the text is still taller than the box.
 *
 * The height comes from the value, not from scrollHeight: a wrapped
 * placeholder counts toward scrollHeight too, so an empty box would grow to
 * its own hint's lines. Only typed text scrolls, so a placeholder that
 * overflows the box stays cut off instead of showing a scrollbar.
 */
export function autoGrowTextarea(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = `${ta.value ? Math.min(ta.scrollHeight, 200) : ta.clientHeight}px`;
  ta.style.overflowY = ta.value && ta.scrollHeight > ta.clientHeight ? "auto" : "hidden";
}

function getVisibleTopBoundary(element: HTMLElement): number {
  let visibleTop = window.visualViewport?.offsetTop ?? 0;

  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "clip") {
      visibleTop = Math.max(visibleTop, parent.getBoundingClientRect().top + parent.clientTop);
    }
  }

  return visibleTop;
}

function subscribeUpwardMenuMaxHeight(
  menu: HTMLElement,
  onChange: (height: number) => void,
): () => void {
  let frameId: number | null = null;
  const update = () => {
    frameId = null;
    onChange(getUpwardMenuMaxHeight(
      menu.getBoundingClientRect().bottom,
      getVisibleTopBoundary(menu),
    ));
  };
  const scheduleUpdate = () => {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(update);
  };

  update();
  const parent = menu.parentElement;
  const layoutContainer = parent?.parentElement;
  const anchorObserver = typeof ResizeObserver === "undefined" || !parent
    ? null
    : new ResizeObserver(scheduleUpdate);
  if (parent) anchorObserver?.observe(parent);
  if (layoutContainer) anchorObserver?.observe(layoutContainer);
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", scheduleUpdate);
  viewport?.addEventListener("scroll", scheduleUpdate);
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("scroll", scheduleUpdate, true);

  return () => {
    anchorObserver?.disconnect();
    viewport?.removeEventListener("resize", scheduleUpdate);
    viewport?.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("resize", scheduleUpdate);
    window.removeEventListener("scroll", scheduleUpdate, true);
    if (frameId !== null) cancelAnimationFrame(frameId);
  };
}


/**
 * R50 (user order, ZCode parity): every palette row and sent chip carries its
 * command's own glyph — goal its target, skills the skill mark, the rest the
 * terminal — before the name (ZCode's GoalIcon/Workflow pattern).
 */
function SlashCommandGlyph({ name }: { name: string }) {
  const Icon = toolIconFor(name.replace(/^skill:/, ""));
  return <Icon size={13} className="slash-command-glyph" aria-hidden="true" />;
}

const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVEL_DESC_KEYS: Record<typeof THINKING_LEVELS[number], string> = {
  auto: "chat.thinkingUseDefault", off: "chat.thinkingOff", minimal: "chat.thinkingMinimal", low: "chat.thinkingLow",
  medium: "chat.thinkingMedium", high: "chat.thinkingHigh", xhigh: "chat.thinkingXhigh", max: "chat.thinkingMax",
};

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString();
}

type BuiltinSlashCommand = {
  name: string;
  description: string;
  source: "builtin";
  availableWhileStreaming?: boolean;
};

type SlashCommandPaletteItem = SlashCommandInfo | BuiltinSlashCommand;

type SlashCommandSource = SlashCommandPaletteItem["source"];

const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  { name: "compact", description: "chat.commandCompact", source: "builtin" },
  { name: "auto-compact", description: "chat.commandAutoCompact", source: "builtin" },
  { name: "reload", description: "chat.commandReload", source: "builtin" },
  { name: "name", description: "chat.commandName", source: "builtin" },
  { name: "session", description: "chat.commandSession", source: "builtin", availableWhileStreaming: true },
  { name: "copy", description: "chat.commandCopy", source: "builtin", availableWhileStreaming: true },
  { name: "clone", description: "chat.commandClone", source: "builtin" },
  { name: "settings", description: "chat.commandSettings", source: "builtin" },
  { name: "scoped-models", description: "chat.commandScopedModels", source: "builtin" },
  { name: "tree", description: "chat.commandTree", source: "builtin" },
  { name: "model", description: "chat.commandModel", source: "builtin", availableWhileStreaming: true },
  { name: "thinking", description: "chat.commandThinking", source: "builtin", availableWhileStreaming: true },
  { name: "export", description: "chat.commandExport", source: "builtin" },
  { name: "new", description: "chat.commandNew", source: "builtin" },
  { name: "debug", description: "chat.commandDebug", source: "builtin" },
  { name: "fork", description: "chat.commandFork", source: "builtin" },
  { name: "resume", description: "chat.commandResume", source: "builtin" },
  { name: "trust", description: "chat.commandTrust", source: "builtin" },
  { name: "login", description: "chat.commandLogin", source: "builtin" },
  { name: "logout", description: "chat.commandLogout", source: "builtin" },
  { name: "changelog", description: "chat.commandChangelog", source: "builtin" },
  { name: "hotkeys", description: "chat.commandHotkeys", source: "builtin" },
  { name: "import", description: "chat.commandImport", source: "builtin" },
  { name: "share", description: "chat.commandShare", source: "builtin" },
  { name: "bug", description: "chat.commandBug", source: "builtin" },
  { name: "quit", description: "chat.commandQuit", source: "builtin" },
];

export function getBuiltinSlashCommand(message: string): BuiltinSlashCommand | undefined {
  const match = message.trim().match(/^\/([^\s]+)(?:\s|$)/);
  if (!match) return undefined;
  return BUILTIN_SLASH_COMMANDS.find((command) => command.name === match[1]);
}

export function canRunBuiltinSlashCommandWhileStreaming(message: string): boolean {
  return getBuiltinSlashCommand(message)?.availableWhileStreaming === true;
}

/**
 * Whether a message sent while a run streams goes to the built-in handler
 * first: a built-in that may run then, or a bare `/mcp`, which opens
 * Settings › MCP when pi's built-in MCP extension owns it (useAgentSession)
 * and is otherwise sent as before.
 */
export function offersBuiltinSlashCommandWhileStreaming(message: string): boolean {
  return canRunBuiltinSlashCommandWhileStreaming(message) || isBareMcpCommand(message);
}

export function isExactSlashCommand(message: string, command: SlashCommandPaletteItem): boolean {
  return command.source === "builtin" && message.trim() === `/${command.name}`;
}

/**
 * Whether Enter on the highlighted palette entry submits the message rather
 * than completing it to "/name ": a built-in typed in full (while a run
 * streams, only one that may run then), or a bare `/mcp` on pi's built-in
 * `/mcp`, which opens Settings › MCP at once, as it does before the command
 * list has loaded. Every other extension command still takes a second Enter.
 */
export function submitsSlashCommandOnEnter(message: string, command: SlashCommandPaletteItem, isStreaming: boolean): boolean {
  if (command.source === "builtin") {
    return isExactSlashCommand(message, command) && (!isStreaming || command.availableWhileStreaming === true);
  }
  return isBuiltinMcpCommand(command) && isBareMcpCommand(message);
}

export function canClearBuiltinCommandInput(message: string, imageCount: number, submittedMessage: string): boolean {
  return imageCount === 0 && message.trim() === submittedMessage;
}

/**
 * Whether the composer box stacks its draft above its buttons instead of sitting
 * them side by side. A phone has no room for the steer and follow-up buttons next
 * to the draft: in one row the two of them take more than half the width and the
 * placeholder is cut to "立即引导 / 排队后...". So while a run streams they move to
 * their own right-aligned row below the draft. Quote mode (`compact`) stacks for
 * its own reason: it is a short excerpt, not a full composer.
 */
export function stacksComposerLayout(compact: boolean, isMobile: boolean, isStreaming: boolean): boolean {
  return compact || (isMobile && isStreaming);
}

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill"];

const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chat.builtIn",
  extension: "chat.extensions",
  prompt: "chat.prompts",
  skill: "chat.skills",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

// pi's TUI matches a skill by its bare name (pi-tui's
// CombinedAutocompleteProvider), so `/copy` finds `skill:copy-text` by prefix;
// the full `skill:<name>` still matches a query that spells the prefix.
function slashMatchRank(command: SlashCommandPaletteItem, query: string): number {
  const name = command.name.toLowerCase();
  const bareName = command.source === "skill" && name.startsWith("skill:") ? name.slice("skill:".length) : name;
  if (bareName === query || name === query) return 0;
  if (bareName.startsWith(query) || name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return 3;
}

function getSlashDescription(command: SlashCommandPaletteItem, t: (key: string) => string): string {
  return command.source === "builtin" ? t(command.description) : command.description ?? "";
}

/**
 * The palette's matches for a lower-cased query. pi's TUI matches names only;
 * the palette searches descriptions too, but only when no name matches, so
 * `/copy` lists the built-in, not every skill whose description says "copy".
 */
export function filterSlashCommands(
  commands: SlashCommandPaletteItem[],
  query: string,
  t: (key: string) => string,
): SlashCommandPaletteItem[] {
  const ranked = commands.map((command) => ({ command, rank: slashMatchRank(command, query) }));
  const byName = ranked.filter(({ rank }) => rank < 3);
  const matches = byName.length > 0
    ? byName
    : ranked.filter(({ command }) => getSlashDescription(command, t).toLowerCase().includes(query));
  return matches
    .sort((a, b) => a.rank - b.rank
      || SLASH_SOURCE_ORDER[a.command.source] - SLASH_SOURCE_ORDER[b.command.source]
      || TEXT_COLLATOR.compare(a.command.name, b.command.name))
    .map(({ command }) => command);
}

// Skill slash commands are named "skill:<skillName>"; look the skill up in the
// dormancy map fetched from /api/skills. Unknown skills are treated as active.
function isDormantSkillCommand(command: SlashCommandPaletteItem, dormancy: Record<string, boolean>): boolean {
  if (command.source !== "skill" || !command.name.startsWith("skill:")) return false;
  return dormancy[command.name.slice("skill:".length)] === true;
}

export function buildSlashCommandLayout(
  commands: SlashCommandPaletteItem[],
  dormancy: Record<string, boolean>,
) {
  let index = 0;
  const groups = SLASH_SOURCES
    .map((source) => {
      const sourceCommands = commands.filter((command) => command.source === source);
      const orderedCommands = source === "skill"
        ? [
            ...sourceCommands.filter((command) => !isDormantSkillCommand(command, dormancy)),
            ...sourceCommands.filter((command) => isDormantSkillCommand(command, dormancy)),
          ]
        : sourceCommands;
      return {
        source,
        items: orderedCommands.map((command) => ({ command, index: index++ })),
      };
    })
    .filter((group) => group.items.length > 0);

  return {
    commands: groups.flatMap((group) => group.items.map(({ command }) => command)),
    groups,
  };
}

// Attached images go to pi as they are: pi resizes prompt images itself, following
// images.autoResize and the model's inputLimits.images.resize.
export function readImageFile(file: Blob, mimeType: string): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result.split(",")[1] : undefined;
      if (!data) {
        reject(new Error("Failed to read image"));
        return;
      }
      resolve({ data, mimeType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(draftImageToAttachedImage);
}

export function canRestoreUserMessage(
  value: string,
  attachedImageCount: number,
  pendingImageCount: number,
): boolean {
  return !value.trim() && attachedImageCount === 0 && pendingImageCount === 0;
}

export function getUserMessageText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function getUserMessageDraftImages(message: UserMessage): ChatDraftImage[] {
  if (typeof message.content === "string") return [];
  return message.content.flatMap((block) => {
    if (block.type !== "image") return [];

    // Support both the current nested image format and older flat pi-ai entries.
    const flat = block as unknown as { data?: unknown; mimeType?: unknown };
    const data = block.source?.type === "base64" ? block.source.data : flat.data;
    const mimeType = block.source?.type === "base64" ? block.source.media_type : flat.mimeType;
    if (typeof data !== "string" || typeof mimeType !== "string") return [];

    const image = { data, mimeType };
    return isBase64ImageWithinLimits(image) ? [image] : [];
  });
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

function QueuedMessageRow({ kind, text }: { kind: "steer" | "follow-up"; text: string }) {
  return (
    <div
      title={text}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 10px",
        fontSize: "var(--font-size-sm)",
        color: "var(--text-muted)",
        minWidth: 0,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          fontSize: "var(--font-size-xs)",
          fontFamily: "var(--font-mono)",
          padding: "1px 7px",
          borderRadius: 999,
          border: `1px solid ${kind === "steer" ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
          color: kind === "steer" ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        {kind}
      </span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
    </div>
  );
}

function ModelNoticeBanner({ tone, title, body, onClose }: { tone: "error" | "warning"; title: string; body: string; onClose?: () => void }) {
  const { t } = useI18n();
  const feedback = tone === "error" ? "var(--feedback-danger)" : "var(--feedback-warning)";
  return (
    <div
      role="alert"
      className="composer-banner"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: "7px 10px",
        overflowY: "auto",
        border: `1px solid color-mix(in srgb, ${feedback} 30%, transparent)`,
        borderRadius: "var(--radius-sm)",
        background: `color-mix(in srgb, ${feedback} 7%, transparent)`,
        color: feedback,
        fontSize: "var(--font-size-sm)",
        lineHeight: 1.45,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{body}</div>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={t("sidebar.dismiss")}
          style={{
            flexShrink: 0,
            background: "none",
            border: "none",
            padding: "0 2px",
            cursor: "pointer",
            color: "inherit",
            opacity: 0.7,
            fontSize: "var(--font-size-caption)",
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** The session's folder no longer exists: nothing was sent, and no model was asked (#1422). */
export function MissingCwdBanner({ cwd }: { cwd?: string | null }) {
  const { t } = useI18n();
  if (!cwd) return null;
  return <ModelNoticeBanner tone="error" title={t("chat.cwdMissingTitle")} body={t("chat.cwdMissingBody", { cwd })} />;
}

export function ModelErrorBanner({ error }: { error?: string | null }) {
  const { t } = useI18n();
  if (!error) return null;
  return <ModelNoticeBanner tone="error" title={t("chat.modelError")} body={error} />;
}

/** True when the selected model is known to accept image input (#584). Unknown modality info never blocks the user. */
export function modelSupportsImageInput(
  model: { provider: string; modelId: string } | null | undefined,
  modelList: { id: string; name: string; provider: string; input?: string[] }[] | undefined
): boolean {
  if (!model) return true;
  const entry = modelList?.find((m) => m.provider === model.provider && m.id === model.modelId);
  if (!entry || !entry.input) return true;
  return entry.input.includes("image");
}

/** Surfaces `enabledModels` patterns that matched nothing, so a typo is visible (#307). */
export function ModelScopeWarningBanner({ warnings }: { warnings?: string[] }) {
  const { t } = useI18n();
  if (!warnings || warnings.length === 0) return null;
  return (
    <ModelNoticeBanner
      tone="warning"
      title={warnings.length > 1 ? t("chat.modelScopeWarnings") : t("chat.modelScopeWarning")}
      body={warnings.join("\n")}
    />
  );
}

// Memoized: its props hold still while a reply streams or a tool runs, and the
// chat around it re-renders through both.
export const ChatInput = memo(forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, model, isAutoModelSelection, modelNames, modelList, modelError, missingCwd, modelScopeWarnings, onModelChange, modelSwitching,
  defaultModel, onSetDefaultModel,
  isCompacting, compactError, onDismissCompactError, compactResult,
  thinkingLevel, isAutoThinkingSelection = false, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  savedDefaultThinkingLevel, onSetDefaultThinkingLevel,
  retryInfo, queuedMessages, inputHistory = [], onRecallQueue,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  soundEnabled, onSoundToggle, onAudioUnlock,
  onPromptWithStreamingBehavior,
  draftKey,
  cwd,
  onAttachFiles,
  leadingAction,
  compact = false,
}: Props, ref) {
  const { t } = useI18n();
  const { fontSize } = useChatAppearance();
  const { ui: uiFontFamily, uiWeight } = useFontPreferences();
  const isMobile = useIsMobile();
  const enterSendMode = useEnterSendMode();
  const [value, setValue] = useState(() => (draftKey ? getDraft(draftKey)?.value ?? "" : ""));
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [thinkingSearch, setThinkingSearch] = useState("");
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? draftImagesToAttachedImages(getDraft(draftKey)?.images) : []
  ));
  const trimmedValue = value.trimStart();
  const bashMode = attachedImages.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashMenuMaxHeight, setSlashMenuMaxHeight] = useState<number | null>(null);
  // Skills have their own trigger: `#` opens the full catalog (dormant layer
  // included), while `/` lists commands only.
  const [hashMenuOpen, setHashMenuOpen] = useState(false);
  const [hashActiveIndex, setHashActiveIndex] = useState(0);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atMenuMaxHeight, setAtMenuMaxHeight] = useState<number | null>(null);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [imageWarningDismissed, setImageWarningDismissed] = useState(false);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
  const [builtinCommandPending, setBuiltinCommandPending] = useState(false);
  const builtinCommandPendingRef = useRef(false);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);
  const [skillDormancyState, setSkillDormancyState] = useState<{
    cwd: string;
    values: Record<string, boolean>;
  } | null>(null);
  const skillDormancy = cwd && skillDormancyState?.cwd === cwd
    ? skillDormancyState.values
    : {};

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const controlsMenuRef = useRef<HTMLDivElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hashMenuRef = useRef<HTMLDivElement>(null);
  const hashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atMenuRef = useRef<HTMLDivElement>(null);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const draftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  const attachedImagesRef = useRef(attachedImages);
  const pendingImageCountRef = useRef(0);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;

  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      valueRef.current = text;
      setValue(text);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        autoGrowTextarea(ta);
      });
    },
    replaceMessage(message: UserMessage) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (!canRestoreUserMessage(current, attachedImagesRef.current.length, pendingImageCountRef.current)) return;

      const restoredText = getUserMessageText(message);
      const restoredImages = draftImagesToAttachedImages(getUserMessageDraftImages(message));
      valueRef.current = restoredText;
      attachedImagesRef.current = restoredImages;
      setValue(restoredText);
      setAtQuery(null);
      setHistoryMenuOpen(false);
      setAttachedImages((prev) => {
        prev.forEach(revokeImagePreview);
        return restoredImages;
      });
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        autoGrowTextarea(ta);
      });
    },
    prependText(text: string) {
      if (!text.trim()) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      // Mirrors the TUI's queue restore: queued text first, then whatever
      // the user already typed, separated by a blank line.
      const combined = [text, current].filter((t) => t.trim()).join("\n\n");
      valueRef.current = combined;
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(combined.length, combined.length);
        autoGrowTextarea(ta);
      });
    },
    rekeyDraft(previousKey: string, nextKey: string) {
      if (previousKey === nextKey) return;
      if (draftKeyRef.current !== previousKey) {
        rekeyStoredDraft(previousKey, nextKey);
        return;
      }

      const currentDraft = {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
      };
      const moved = rekeyStoredDraft(previousKey, nextKey, currentDraft) ?? { value: "", images: [] };
      const unchanged = moved.value === currentDraft.value
        && moved.images.length === currentDraft.images.length
        && moved.images.every((image, index) => (
          image.data === currentDraft.images[index]?.data
          && image.mimeType === currentDraft.images[index]?.mimeType
        ));
      draftKeyRef.current = nextKey;
      if (unchanged) return;

      const movedImages = draftImagesToAttachedImages(moved.images);
      valueRef.current = moved.value;
      attachedImagesRef.current = movedImages;
      setValue(moved.value);
      setAttachedImages((current) => {
        current.forEach(revokeImagePreview);
        return movedImages;
      });
      setAtQuery(null);
      setHistoryMenuOpen(false);
    },
    restoreSubmission(text: string, images?: ChatDraftImage[], targetDraftKey?: string) {
      if (!text.trim() && !images?.length) return;

      // clearInput is queued before the submission handler runs. Compose with
      // that queued state so a fast rejection cannot observe stale DOM text and
      // then get overwritten by the clear.
      const currentDraftKey = draftKeyRef.current;
      const destinationDraftKey = targetDraftKey ?? currentDraftKey;
      const targetsCurrentComposer = destinationDraftKey === currentDraftKey;
      const storedDraft = !targetsCurrentComposer && destinationDraftKey
        ? getDraft(destinationDraftKey)
        : null;
      const restoredDraft = mergeRestoredSubmissionDraft(
        text,
        images,
        targetsCurrentComposer ? valueRef.current : (storedDraft?.value ?? ""),
        targetsCurrentComposer
          ? attachedImagesRef.current.map(imageToDraftImage)
          : (storedDraft?.images ?? []),
      );
      // The first optimistic message switches ChatWindow out of its empty-state
      // layout and remounts this component. Persist synchronously so recovery is
      // not lost if this instance is the one being unmounted.
      if (destinationDraftKey) setDraft(destinationDraftKey, restoredDraft);
      if (!targetsCurrentComposer) return;
      const restoredImages = images?.length
        ? [
            ...draftImagesToAttachedImages(images).slice(
              0,
              Math.max(0, MAX_ATTACHED_IMAGES - attachedImagesRef.current.length),
            ),
            ...attachedImagesRef.current,
          ].slice(0, MAX_ATTACHED_IMAGES)
        : attachedImagesRef.current;
      // Session promotion can rekey this composer before React flushes the
      // functional updates below, so update the imperative snapshot first.
      valueRef.current = restoredDraft.value;
      attachedImagesRef.current = restoredImages;
      setValue((current) => {
        const restored = mergeRestoredSubmissionText(text, current);
        valueRef.current = restored;
        return restored;
      });
      setAtQuery(null);
      setHistoryMenuOpen(false);
      if (images?.length) {
        setAttachedImages((current) => {
          const available = Math.max(0, MAX_ATTACHED_IMAGES - current.length);
          const restored = draftImagesToAttachedImages(images)
            .slice(0, available);
          const next = restored.length > 0 ? [...restored, ...current] : current;
          attachedImagesRef.current = next;
          return next;
        });
      }
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        autoGrowTextarea(ta);
      });
    },
    // The caret goes after a draft that came back, so typing continues it.
    focus() {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      replaceTextareaRange(ta, start, end, sep + text);
      setAtQuery(null);
    },
    addImages(files: File[]) {
      processImageFiles(files);
    },
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    if (compact) return;
    const remaining = Math.max(
      0,
      MAX_ATTACHED_IMAGES - attachedImagesRef.current.length - pendingImageCountRef.current,
    );
    const imageFiles = files
      .filter((f) => f.type.startsWith("image/") && f.size <= MAX_ATTACHED_IMAGE_BYTES)
      .slice(0, remaining);
    if (!imageFiles.length) return;
    pendingImageCountRef.current += imageFiles.length;
    try {
      const newImages = await Promise.all(
        imageFiles.map(async (file) => ({
          ...await readImageFile(file, file.type),
          previewUrl: URL.createObjectURL(file),
        }))
      );
      setAttachedImages((prev) => {
        const accepted = newImages.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - prev.length));
        newImages.slice(accepted.length).forEach(revokeImagePreview);
        const next = [...prev, ...accepted];
        attachedImagesRef.current = next;
        return next;
      });
    } finally {
      pendingImageCountRef.current -= imageFiles.length;
    }
  }, [compact]);

  const handleFilePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Clearing the value lets the same file be picked again.
    e.target.value = "";
    if (onAttachFiles) onAttachFiles(files);
    else processImageFiles(files);
  }, [onAttachFiles, processImageFiles]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      attachedImagesRef.current = next;
      return next;
    });
  }, []);

  const clearImages = useCallback(() => {
    attachedImagesRef.current = [];
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  const clearInput = useCallback(() => {
    valueRef.current = "";
    setValue("");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [clearImages, draftKey]);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    setDraft(draftKey, {
      value,
      images: attachedImages.map(imageToDraftImage),
    });
  }, [attachedImages, draftKey, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;

    if (previousDraftKey) {
      setDraft(previousDraftKey, {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    const nextValue = draft?.value ?? "";
    const nextImages = draftImagesToAttachedImages(draft?.images);
    valueRef.current = nextValue;
    attachedImagesRef.current = nextImages;
    setValue(nextValue);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return nextImages;
    });
  }, [draftKey]);

  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (ta.value) autoGrowTextarea(ta);
    else ta.style.overflowY = "hidden";
  }, []);

  useLayoutEffect(resizeTextarea, [value, fontSize, uiFontFamily, uiWeight, resizeTextarea]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    let previousWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      // Height updates also notify the observer; only remeasure on width changes.
      if (entry.contentRect.width === previousWidth) return;
      previousWidth = entry.contentRect.width;
      resizeTextarea();
    });
    observer.observe(ta);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Shift+Enter on desktop, Enter on mobile keyboards: every newline the
    // textarea inserts arrives here, while IME confirmations and sends do not.
    const continueList = (event: InputEvent) => {
      if (event.inputType !== "insertLineBreak" || event.isComposing) return;
      const edit = getMarkdownListContinuation(ta.value, ta.selectionStart, ta.selectionEnd);
      if (!edit) return;
      event.preventDefault();
      ta.setSelectionRange(edit.start, edit.end);
      // insertText keeps the edit on the native undo stack and fires the input
      // event that updates the controlled value.
      document.execCommand(edit.text ? "insertText" : "delete", false, edit.text);
    };
    ta.addEventListener("beforeinput", continueList);
    return () => ta.removeEventListener("beforeinput", continueList);
  }, []);

  useEffect(() => {
    return () => {
      attachedImagesRef.current.forEach(revokeImagePreview);
    };
  }, []);

  const runBuiltinCommand = useCallback(async (msg: string): Promise<boolean> => {
    if (attachedImages.length || !msg.startsWith("/") || !onBuiltinCommand) return false;
    if (builtinCommandPendingRef.current) return true;
    builtinCommandPendingRef.current = true;
    setBuiltinCommandPending(true);
    try {
      const result = await onBuiltinCommand(msg);
      if (!result.handled) return false;
      if (!result.error && canClearBuiltinCommandInput(valueRef.current, attachedImagesRef.current.length, msg)) clearInput();
      return true;
    } finally {
      builtinCommandPendingRef.current = false;
      setBuiltinCommandPending(false);
    }
  }, [attachedImages.length, clearInput, onBuiltinCommand]);

  // Skills are no longer slash commands: `/` lists commands, `#` lists the
  // whole skill catalog (dormant layer included). The session's command list is
  // the truth for what `/skill:name` can expand, so `#` offers exactly those.
  const skillCommands = (slashCommands ?? []).filter((command) => command.source === "skill");
  const knownSkillNames = new Set(skillCommands.map((command) => command.name.slice("skill:".length)));

  const handleSend = useCallback(async () => {
    const raw = value.trim();
    if (!raw && !attachedImages.length) return;
    onAudioUnlock?.();
    // `#name` is the composer's skill trigger; pi's expander reads `/skill:name`.
    const msg = skillCommandToSessionText(raw, knownSkillNames);
    const builtinAllowed = !isStreaming || offersBuiltinSlashCommandWhileStreaming(raw);
    if (builtinAllowed && await runBuiltinCommand(raw)) return;
    if (isStreaming) return;
    clearInput();
    onSend(msg, attachedImages.length ? attachedImages : undefined);
  }, [value, attachedImages, isStreaming, runBuiltinCommand, onSend, clearInput, onAudioUnlock, knownSkillNames]);

  const slashQuery = !compact && value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;

  // Skills are no longer slash commands: `/` lists commands, `#` lists the
  // whole skill catalog (dormant layer included). The session's command list is
  // the truth for what `/skill:name` can expand, so `#` offers exactly those.
  const hashQuery = !compact && value.startsWith("#") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;
  const hashSkillMatches = (() => {
    if (hashQuery === null) return [];
    const matched = hashQuery
      ? skillCommands.filter((command) => command.name.slice("skill:".length).toLowerCase().includes(hashQuery))
      : skillCommands;
    // Active skills first, the dormant layer last, then by name — the slash
    // palette's rule, without its source groups.
    const dormantRank = (command: SlashCommandInfo) =>
      skillDormancy[command.name.slice("skill:".length)] ? 1 : 0;
    return [...matched].sort((a, b) => dormantRank(a) - dormantRank(b) || a.name.localeCompare(b.name));
  })();

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const builtinCommands = isStreaming
      ? BUILTIN_SLASH_COMMANDS.filter((command) => command.availableWhileStreaming)
      : BUILTIN_SLASH_COMMANDS;
    const commands = [...builtinCommands, ...(slashCommands ?? []).filter((command) => command.source !== "skill")];
    return filterSlashCommands(commands, slashQuery, t);
  })();

  const {
    commands: displayedSlashCommands,
    groups: groupedSlashCommands,
  } = buildSlashCommandLayout(filteredSlashCommands, skillDormancy);

  const slashCommandCountLabel = filteredSlashCommands.length === 1
    ? t(slashQuery ? "chat.match" : "chat.command")
    : t(slashQuery ? "chat.matches" : "chat.commands", { count: filteredSlashCommands.length });
  const hasInputText = Boolean(value.trim());
  const canQueueStreamingMessage = hasInputText || attachedImages.length > 0;
  const stackedComposer = stacksComposerLayout(compact, isMobile, isStreaming);
  // Warn when images are attached but the selected model is known not to accept
  // image input (#584), including a resolved default. Unknown models stay silent.
  const showImageUnsupportedWarning = (
    attachedImages.length > 0
    && !modelSupportsImageInput(model, modelList)
    && !imageWarningDismissed
  );
  useEffect(() => {
    if (attachedImages.length === 0) setImageWarningDismissed(false);
  }, [attachedImages.length]);

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    if (!cwd) {
      setAtQuery(null);
      return;
    }
    const pos = cursor ?? text.length;
    setAtQuery(extractAtQuery(text.slice(0, pos)));
  }, [cwd]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    setFileIndexLoading(true);
    fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
      })
      .then((data) => {
        setFileIndex({ cwd: fetchCwd, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        fileIndexFetchingRef.current = null;
        setFileIndexLoading(false);
      });
  }, [atTokenActive, cwd]);

  const applyAtCompletion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? ta.value.length;
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): replace that old quote too, since the insertion has one.
    const replaceEnd = cursor + (atQuery.quoted && ta.value[cursor] === '"' ? 1 : 0);
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newPos = atQuery.start + insert.cursorOffset;
    replaceTextareaRange(ta, atQuery.start, replaceEnd, insert.text, insert.cursorOffset);
    // The native input event updates the controlled value. Re-derive using the
    // adjusted caret because quoted directories place it before the last quote.
    setAtQuery(extractAtQuery(ta.value.slice(0, newPos)));
  }, [atQuery]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  useEffect(() => {
    if (historyActiveIndex >= inputHistory.length) {
      setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
    }
  }, [inputHistory.length, historyActiveIndex]);

  useEffect(() => {
    historyItemRefs.current.length = inputHistory.length;
  }, [inputHistory.length]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    historyItemRefs.current[historyActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [historyActiveIndex, historyMenuOpen]);

  const applyHistoryInput = useCallback((text: string) => {
    setValue(text);
    setHistoryMenuOpen(false);
    setHistoryActiveIndex(0);
    setAtQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      autoGrowTextarea(ta);
    });
  }, []);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `/${command.name} `;
    setValue(nextValue);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      autoGrowTextarea(ta);
    });
  }, []);

  const applySkillCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `#${command.name.slice("skill:".length)} `;
    setValue(nextValue);
    setHashMenuOpen(false);
    setHashActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      autoGrowTextarea(ta);
    });
  }, []);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const raw = value.trim();
    if (!raw && !attachedImages.length) return;
    onAudioUnlock?.();
    // A `#name` skill goes out as the `/skill:name` pi expands.
    const msg = skillCommandToSessionText(raw, knownSkillNames);
    const images = attachedImages.length ? attachedImages : undefined;
    const queue = () => {
      const streamingBehavior = mode === "steer" ? "steer" : "followUp";
      if (msg.startsWith("/") && onPromptWithStreamingBehavior) {
        clearInput();
        onPromptWithStreamingBehavior(msg, streamingBehavior, images);
        return;
      }
      clearInput();
      if (mode === "steer" && onSteer) {
        onSteer(msg, images);
      } else if (mode === "followup" && onFollowUp) {
        onFollowUp(msg, images);
      }
    };
    if (!attachedImages.length && onBuiltinCommand && canRunBuiltinSlashCommandWhileStreaming(msg)) {
      void runBuiltinCommand(msg);
      return;
    }
    if (!attachedImages.length && onBuiltinCommand && isBareMcpCommand(msg)) {
      // Settings › MCP opens when pi's built-in MCP extension owns /mcp; another
      // extension's /mcp is queued as before. The composer is disabled meanwhile.
      void runBuiltinCommand(msg).then((handled) => {
        if (!handled) queue();
      }, () => queue());
      return;
    }
    queue();
  }, [value, attachedImages, onBuiltinCommand, onPromptWithStreamingBehavior, onSteer, onFollowUp, clearInput, onAudioUnlock, runBuiltinCommand]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") =>
    nextIndexInDirection(slashActiveIndex, displayedSlashCommands.length, slashItemRefs.current, direction),
  [displayedSlashCommands.length, slashActiveIndex]);

  const getNextSkillIndex = useCallback((direction: "up" | "down" | "left" | "right") =>
    nextIndexInDirection(hashActiveIndex, hashSkillMatches.length, hashItemRefs.current, direction),
  [hashActiveIndex, hashSkillMatches.length]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const enterKey = e.key === "Enter" && !e.shiftKey;
      const sendShortcut = isMobile || enterSendMode === "ctrlEnter"
        ? enterKey && (e.ctrlKey || e.metaKey)
        : enterKey;
      // Popup menus and the IME guard take plain Enter in either send mode on a
      // desktop keyboard. Mobile keyboards insert a line break on Enter, so they
      // keep using the send shortcut there.
      const acceptShortcut = isMobile ? sendShortcut : enterKey;
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (acceptShortcut && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (historyMenuOpen && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.min(Math.max(0, inputHistory.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHistoryMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || acceptShortcut) && inputHistory[historyActiveIndex]) {
          e.preventDefault();
          applyHistoryInput(inputHistory[historyActiveIndex]);
          return;
        }
      }

      if (slashMenuOpen && slashQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        const selectedCommand = displayedSlashCommands[slashActiveIndex];
        if (e.key === "Tab" && selectedCommand) {
          e.preventDefault();
          applySlashCommand(selectedCommand);
          return;
        }
        if (acceptShortcut && selectedCommand) {
          e.preventDefault();
          if (sendShortcut && submitsSlashCommandOnEnter(value, selectedCommand, isStreaming)) {
            setSlashMenuOpen(false);
            void handleSend();
          } else {
            applySlashCommand(selectedCommand);
          }
          return;
        }
      }

      // # skill menu — the full catalog (dormant layer included), Enter/Tab
      // inserts `#name ` so arguments can follow before sending. All four
      // arrows move through the grid, matching what the cards look like.
      if (hashMenuOpen && hashQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHashActiveIndex(getNextSkillIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHashActiveIndex(getNextSkillIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setHashActiveIndex(getNextSkillIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setHashActiveIndex(getNextSkillIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHashMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || acceptShortcut) && hashSkillMatches[hashActiveIndex]) {
          e.preventDefault();
          applySkillCommand(hashSkillMatches[hashActiveIndex]);
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => cycleListIndex(i, atMatches.length, 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => cycleListIndex(i, atMatches.length, -1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || acceptShortcut) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "ArrowUp" && !isComposing && !isStreaming && inputHistory.length > 0 && value.trim().length === 0) {
        e.preventDefault();
        setSlashMenuOpen(false);
        setAtMenuOpen(false);
        setHistoryActiveIndex(inputHistory.length - 1);
        setHistoryMenuOpen(true);
        return;
      }

      // Esc stops the agent when no slash/@/history menu or IME composition is active.
      if (e.key === "Escape" && !isComposing && isStreaming && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }

      if (sendShortcut) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          sendQueued((e.altKey && onFollowUp) || !onSteer ? "followup" : "steer");
        } else {
          handleSend();
        }
      }
    },
    [isMobile, enterSendMode, isStreaming, onSteer, onFollowUp, onAbort, slashMenuOpen, slashQuery, displayedSlashCommands, slashActiveIndex, applySlashCommand, sendQueued, handleSend, getNextSlashIndex, hashMenuOpen, hashQuery, hashSkillMatches, hashActiveIndex, applySkillCommand, getNextSkillIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value]
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    autoGrowTextarea(ta);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!compact && imageItems.length) {
      e.preventDefault();
      const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      processImageFiles(files);
      return;
    }

    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (!html || !text) return;
    const document = new DOMParser().parseFromString(html, "text/html");
    const links = Array.from(document.querySelectorAll("a[href]"), (link) => {
      const label = link.textContent ?? "";
      const range = document.createRange();
      range.setStart(document.body, 0);
      range.setEndBefore(link);
      return {
        label,
        href: link.getAttribute("href")?.trim() ?? "",
        occurrence: label ? range.toString().split(label).length - 1 : 0,
      };
    });
    const markdown = replaceLinksWithMarkdown(text, links);
    if (markdown === null) return;

    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const nextValue = ta.value.slice(0, start) + markdown + ta.value.slice(ta.selectionEnd);
    e.preventDefault();
    valueRef.current = nextValue;
    setValue(nextValue);
    setHistoryMenuOpen(false);
    updateAtQuery(nextValue, start + markdown.length);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + markdown.length, start + markdown.length);
    });
  }, [compact, processImageFiles, updateAtQuery]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  // `#` shares the command request: the same session list decides which skills
  // are invocable, so the palette and the expander never disagree.
  useEffect(() => {
    if (hashQuery === null) {
      setHashMenuOpen(false);
      setHashActiveIndex(0);
      return;
    }
    setHashMenuOpen(true);
    setHashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [hashQuery, onLoadSlashCommands]);

  // Lazy-load skill dormancy (disable-model-invocation) each time either
  // palette opens, so toggles made in the skills panel are reflected on the
  // next open. Failures degrade silently to the unannotated palette.
  useEffect(() => {
    if (!(slashMenuOpen || hashMenuOpen) || !cwd) return;
    const requestCwd = cwd;
    let cancelled = false;
    setSkillDormancyState({ cwd: requestCwd, values: {} });
    fetch(`/api/skills?cwd=${encodeURIComponent(requestCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`skills fetch failed: ${res.status}`);
        return res.json() as Promise<Partial<SkillsResponse>>;
      })
      .then((data) => {
        if (cancelled) return;
        const dormancy: Record<string, boolean> = {};
        for (const skill of data.skills ?? []) dormancy[skill.name] = skill.disableModelInvocation;
        setSkillDormancyState({ cwd: requestCwd, values: dormancy });
      })
      .catch(() => {
        if (!cancelled) setSkillDormancyState({ cwd: requestCwd, values: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [slashMenuOpen, hashMenuOpen, cwd]);

  useEffect(() => {
    if (hashActiveIndex >= hashSkillMatches.length) {
      setHashActiveIndex(Math.max(0, hashSkillMatches.length - 1));
    }
  }, [hashSkillMatches.length, hashActiveIndex]);

  useEffect(() => {
    hashItemRefs.current.length = hashSkillMatches.length;
  }, [hashSkillMatches.length]);

  useEffect(() => {
    if (!hashMenuOpen) return;
    hashItemRefs.current[hashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [hashActiveIndex, hashMenuOpen]);

  useEffect(() => {
    if (slashActiveIndex >= displayedSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, displayedSlashCommands.length - 1));
    }
  }, [displayedSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = displayedSlashCommands.length;
  }, [displayedSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  useLayoutEffect(() => {
    if (!slashMenuOpen || slashQuery === null) {
      setSlashMenuMaxHeight(null);
      return;
    }
    const menu = slashMenuRef.current;
    if (!menu) return;
    return subscribeUpwardMenuMaxHeight(menu, (nextHeight) => {
      setSlashMenuMaxHeight((current) => current === nextHeight ? current : nextHeight);
    });
  }, [slashMenuOpen, slashQuery]);

  useLayoutEffect(() => {
    if (!atMenuOpen || atQuery === null) {
      setAtMenuMaxHeight(null);
      return;
    }
    const menu = atMenuRef.current;
    if (!menu) return;
    return subscribeUpwardMenuMaxHeight(menu, (nextHeight) => {
      setAtMenuMaxHeight((current) => current === nextHeight ? current : nextHeight);
    });
  }, [atMenuOpen, atQuery]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelSelectorOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }));
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    }));
  })();

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactResultText = compactResult
    ? `${compactResult.reason && compactResult.reason !== "manual" ? `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)} ` : t("chat.compacted")} ${formatTokenCount(compactResult.tokensBefore)} -> ${formatTokenCount(compactResult.estimatedTokensAfter)} tokens (${t("chat.tokensSaved", { saved: formatTokenCount(compactSavedTokens) })})`
    : null;
  const resolvedThinkingLevel = thinkingLevel && thinkingLevel !== "auto" ? thinkingLevel : null;
  const thinkingDisplayLabel = (() => {
    const lvl = resolvedThinkingLevel ?? "auto";
    if (lvl === "auto" || !thinkingLevelMap) return lvl;
    return thinkingLevelMap[lvl] ?? lvl;
  })();
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ query?: string }>).detail;
      setThinkingSearch(detail?.query ?? "");
      setThinkingDropdownOpen(true);
    };
    window.addEventListener("pi-web:open-thinking-selector", open);
    return () => window.removeEventListener("pi-web:open-thinking-selector", open);
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false);
        setThinkingSearch("");
      }
      if (controlsMenuRef.current && !controlsMenuRef.current.contains(e.target as Node)) {
        setControlsMenuOpen(false);
      }
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node) && !textareaRef.current?.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!isMobile) setControlsMenuOpen(false);
  }, [isMobile]);



  // The submit cluster: while a run streams it is the steer / follow-up pair
  // in ZCode's ghost-button vocabulary (§1.5); idle it is the send button
  // (§1.2) — a 28px circle on the brand fill whose arrow spins into the
  // loader circle while a submitted built-in command settles.
  const composerSubmitControl = isStreaming ? (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "flex-end" }}>
      {onSteer && (
        <button
          type="button"
          className="composer-queue-button"
          onClick={() => sendQueued("steer")}
          disabled={!canQueueStreamingMessage}
          title={t("chat.steerHint")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </svg>
          {t("chat.steer")}
        </button>
      )}
      {onFollowUp && (
        <button
          type="button"
          className="composer-queue-button"
          onClick={() => sendQueued("followup")}
          disabled={!canQueueStreamingMessage}
          title={`${t("chat.followUpHint")} (${isMobile ? "Ctrl/Cmd+" : ""}Alt/Option+Enter)`}
          aria-keyshortcuts={isMobile ? "Control+Alt+Enter Meta+Alt+Enter" : "Alt+Enter"}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m5 12 7-7 7 7" />
            <path d="M12 19V5" />
          </svg>
          {t("chat.followUp")}
        </button>
      )}
    </div>
  ) : (
    <button
      type="button"
      className={`composer-send${builtinCommandPending ? " is-submitting" : ""}`}
      onClick={handleSend}
      disabled={(!value.trim() && !attachedImages.length) || builtinCommandPending}
      title={t("chat.send")}
      aria-label={t("chat.send")}
    >
      {builtinCommandPending ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m5 12 7-7 7 7" />
          <path d="M12 19V5" />
        </svg>
      )}
    </button>
  );

  return (
    <fieldset
      disabled={builtinCommandPending}
      aria-busy={builtinCommandPending}
      className={compact ? undefined : "chat-input-shell"}
      style={{
        // Never taller than the chat: a short window shrinks the queue first (#1428).
        ...(compact ? { flexShrink: 0 } : { display: "flex", flexDirection: "column", minHeight: 0 }),
        minWidth: 0,
        margin: 0,
        border: 0,
        background: "transparent",
        // ZCode's dock (ConversationTimeline.tsx:2287-2295): the dock content
        // carries px-2 pb-4 and the composer surface fills it. The old 36px
        // right-side minimap rail reservation is gone (S1.2): the 8px dock
        // padding and the 16px bottom live on the width-capped wrapper below
        // and on ChatWindow's dock column, so the surface tracks the same box
        // as the message column.
        padding: 0,
        opacity: builtinCommandPending ? 0.5 : 1,
        transition: "opacity 0.15s",
      }}
    >
      {/* Hidden file input. No `capture`: phones still offer the photo library and camera. */}
      {!compact && <input
        ref={fileInputRef}
        type="file"
        accept={onAttachFiles ? undefined : "image/*"}
        multiple
        style={{ display: "none" }}
        onChange={handleFilePick}
      />}
      <div
        style={{
          ...(compact ? undefined : { display: "flex", flexDirection: "column", minHeight: 0, width: "100%", paddingInline: 8 }),
          maxWidth: "var(--chat-content-adaptive-width, var(--chat-content-max-width, 820px))",
          margin: "0 auto",
          transition: compact ? undefined : "max-width var(--chat-column-resize-transition, 150ms ease-out)",
        }}
      >
        <MissingCwdBanner cwd={missingCwd} />
        <ModelErrorBanner error={modelError} />
        <ModelScopeWarningBanner warnings={modelScopeWarnings} />
        {showImageUnsupportedWarning && (() => {
          const entry = modelList?.find((m) => m.provider === model?.provider && m.id === model?.modelId);
          return (
            <ModelNoticeBanner
              tone="warning"
              title={t("chat.imageNotSupportedTitle")}
              body={t("chat.imageNotSupportedBody", { model: entry?.name || model?.modelId || "" })}
              onClose={() => setImageWarningDismissed(true)}
            />
          );
        })()}
        {/* Queued steering / follow-up messages (delivered by pi on upcoming turns) */}
        {((queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0)) > 0 && (
          <div className="queued-messages-box" style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 72, // the header and one whole row
            marginBottom: 8,
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            background: "var(--bg-panel)",
            padding: "5px 0",
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "2px 8px 4px 10px",
            }}>
              <span style={{
                fontSize: "var(--font-size-xs)",
                fontFamily: "var(--font-mono)",
                color: "var(--text-dim)",
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}>
                {t("chat.queued", { count: (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0) })}
              </span>
              {onRecallQueue && (
                <button
                  onClick={onRecallQueue}
                   title={t("chat.recallTitle")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 12px",
                    fontSize: "var(--font-size-sm)",
                    color: "var(--text)",
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                    transition: "background 0.12s, border-color 0.12s",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.borderColor = "var(--border)";
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 14 4 9 9 4" />
                    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                  </svg>
                   {t("chat.recall")}
                </button>
              )}
            </div>
            {/* Only the rows scroll: a long queue must not push the input and its buttons off screen (#1428). */}
            <div style={{
              maxHeight: "min(180px, calc(var(--app-viewport-height, 100dvh) * 0.25))",
              overflowY: "auto",
              overscrollBehavior: "contain",
            }}>
              {queuedMessages?.steering.map((text, i) => (
                <QueuedMessageRow key={`steer-${i}`} kind="steer" text={text} />
              ))}
              {queuedMessages?.followUp.map((text, i) => (
                <QueuedMessageRow key={`followup-${i}`} kind="follow-up" text={text} />
              ))}
            </div>
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && (
          <div className="composer-banner" style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--feedback-warning) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--feedback-warning) 25%, transparent)",
            borderRadius: "var(--radius-sm)", fontSize: "var(--font-size-sm)",
            color: "color-mix(in srgb, var(--feedback-warning) 76%, #000)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
             {t("chat.retrying", { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {compactResultText && (
          <div className="composer-banner" style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--feedback-ok) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--feedback-ok) 24%, transparent)",
            borderRadius: "var(--radius-sm)", fontSize: "var(--font-size-sm)", color: "var(--feedback-ok)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {compactError && (
          <div
            role="alert"
            className="composer-banner"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
              marginBottom: 8,
              padding: onDismissCompactError ? "3px 3px 3px 10px" : "7px 10px",
              background: "color-mix(in srgb, var(--feedback-danger) 7%, transparent)",
              border: "1px solid color-mix(in srgb, var(--feedback-danger) 30%, transparent)",
              borderRadius: "var(--radius-sm)",
              color: "var(--feedback-danger)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-sm)",
              lineHeight: 1.5,
            }}
          >
            <span style={{ minWidth: 0, flex: 1, padding: onDismissCompactError ? "4px 0" : 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{compactError}</span>
            {onDismissCompactError && <DismissButton onClick={onDismissCompactError} title={t("chat.dismissCompactError")} />}
          </div>
        )}
        {/* Image previews */}
        {attachedImages.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedImages.map((img, i) => (
              <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                <ImagePreview key={img.previewUrl} src={img.previewUrl}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.previewUrl}
                    alt=""
                    style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                  />
                </ImagePreview>
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  style={{
                    position: "absolute", top: -4, right: -4,
                    width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main input */}
        <div style={{ position: "relative", minWidth: 0 }}>
          {historyMenuOpen && inputHistory.length > 0 && (
            <div
              ref={historyMenuRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                boxShadow: "var(--shadow-overlay)",
                overflow: "hidden",
                maxHeight: "min(44vh, 360px)",
              }}
            >
              <div
                title={t("chat.inputHistory")}
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  color: "var(--text-dim)",
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div style={{ maxHeight: "calc(min(44vh, 360px) - 31px)", overflowY: "auto", padding: 4 }}>
                {inputHistory.map((item, index) => {
                  const active = index === historyActiveIndex;
                  return (
                    <button
                      key={`${index}:${item}`}
                      ref={(node) => {
                        historyItemRefs.current[index] = node;
                      }}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyHistoryInput(item);
                      }}
                      onMouseEnter={() => setHistoryActiveIndex(index)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "7px 8px",
                        border: "none",
                        borderRadius: "var(--radius-sm)",
                        background: active ? "var(--bg-selected)" : "none",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: "var(--font-size-sm)",
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: "var(--font-size-sm)", color: "var(--text-dim)", paddingTop: 1 }}>
                        {index + 1}
                      </span>
                      <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
                        {item}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {hashMenuOpen && hashQuery !== null && (
            <div
              ref={hashMenuRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                boxShadow: "var(--shadow-overlay)",
                overflow: "hidden",
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                maxHeight: "min(72.8vh, 598px)",
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: "var(--font-size-sm)",
                  color: "var(--text-dim)",
                  flexShrink: 0,
                }}
              >
                <span>{t("chat.skills")} · {hashSkillMatches.length}</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
              </div>
              <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 10 }}>
                {hashSkillMatches.length === 0 ? (
                  <div style={{ padding: "2px 2px 4px", fontSize: "var(--font-size-sm)", color: "var(--text-dim)" }}>
                    {t("chat.noSkillMatches")}
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
                    {hashSkillMatches.map((command, index) => {
                      const name = command.name.slice("skill:".length);
                      const active = index === hashActiveIndex;
                      const dormant = isDormantSkillCommand(command, skillDormancy);
                      return (
                        <button
                          key={command.name}
                          ref={(node) => {
                            hashItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applySkillCommand(command);
                          }}
                          onMouseEnter={() => setHashActiveIndex(index)}
                          style={{
                            width: "100%",
                            minWidth: 0,
                            minHeight: 58,
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                            justifyContent: "center",
                            padding: "9px 10px",
                            border: "1px solid transparent",
                            borderRadius: "var(--radius-md)",
                            background: active ? "var(--bg-selected)" : "transparent",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            boxShadow: "none",
                          }}
                        >
                          <span style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            fontSize: "var(--font-size-caption)",
                            fontFamily: "var(--font-mono)",
                            overflowWrap: "anywhere",
                            wordBreak: "break-word",
                            color: dormant ? "var(--text-dim)" : undefined,
                          }}>
                            #{name}
                            {dormant && (
                              <span style={{
                                marginLeft: 6,
                                padding: "0 4px",
                                border: "1px solid var(--border)",
                                borderRadius: 3,
                                fontSize: "var(--font-size-xs)",
                                color: "var(--text-dim)",
                                whiteSpace: "nowrap",
                              }}>
                                {t("chat.dormant")}
                              </span>
                            )}
                          </span>
                          {command.description && (
                            <span style={{
                              display: "-webkit-box",
                              WebkitBoxOrient: "vertical",
                              WebkitLineClamp: 2,
                              overflow: "hidden",
                              fontSize: "var(--font-size-sm)",
                              lineHeight: 1.35,
                              color: "var(--text-dim)",
                            }}>
                              {command.description}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
          {slashMenuOpen && slashQuery !== null && (
            <div
              ref={slashMenuRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                boxShadow: "var(--shadow-overlay)",
                overflow: "hidden",
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                maxHeight: slashMenuMaxHeight === null
                  ? "min(72.8vh, 598px)"
                  : `min(72.8vh, 598px, ${slashMenuMaxHeight}px)`,
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: "var(--font-size-sm)",
                  color: "var(--text-dim)",
                  flexShrink: 0,
                }}
              >
                 <span>{slashCommandsLoading ? t("chat.loadingCommands") : t("chat.slashCommands", { label: slashCommandCountLabel })}</span>
                 <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
              </div>
              <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 10 }}>
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: "2px 2px 4px", fontSize: "var(--font-size-sm)", color: "var(--text-dim)" }}>
                     {t("chat.noCommands")}
                  </div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} style={{ marginBottom: 12 }}>
                      <div
                        style={{
                          position: "sticky",
                          top: -10,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "4px 0 6px",
                          background: "var(--popover)",
                          color: "var(--text-dim)",
                          fontSize: "var(--font-size-xs)",
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                           <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: 8,
                        }}
                      >
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex;
                          const dormant = isDormantSkillCommand(command, skillDormancy);
                          return (
                            <button
                              key={`${command.source}:${command.name}`}
                              ref={(node) => {
                                slashItemRefs.current[index] = node;
                              }}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                applySlashCommand(command);
                              }}
                              onMouseEnter={() => setSlashActiveIndex(index)}
                              style={{
                                width: "100%",
                                minWidth: 0,
                                minHeight: 58,
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                                justifyContent: "center",
                                padding: "9px 10px",
                                border: "1px solid transparent",
                                borderRadius: "var(--radius-md)",
                                background: active ? "var(--bg-selected)" : "transparent",
                                color: "var(--text)",
                                cursor: "pointer",
                                textAlign: "left",
                                boxShadow: "none",
                              }}
                            >
                              <span style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                fontSize: "var(--font-size-caption)",
                                fontFamily: "var(--font-mono)",
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                color: dormant ? "var(--text-dim)" : undefined,
                              }}>
                                <SlashCommandGlyph name={command.name} />
                                /{command.name}
                                {dormant && (
                                  <span style={{
                                    marginLeft: 6,
                                    padding: "0 4px",
                                    border: "1px solid var(--border)",
                                    borderRadius: 3,
                                    fontSize: "var(--font-size-xs)",
                                    color: "var(--text-dim)",
                                    whiteSpace: "nowrap",
                                  }}>
                                    {t("chat.dormant")}
                                  </span>
                                )}
                              </span>
                               {command.description && (
                                <span style={{
                                  display: "-webkit-box",
                                  WebkitBoxOrient: "vertical",
                                  WebkitLineClamp: 2,
                                  overflow: "hidden",
                                  fontSize: "var(--font-size-sm)",
                                  lineHeight: 1.35,
                                  color: "var(--text-dim)",
                                }}>
                                   {getSlashDescription(command, t)}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen && atQuery !== null && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
             const matchCountLabel = atMatches.length === 1 ? t("chat.match") : t("chat.matches", { count: atMatches.length });
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.truncated && !serverResultInUse
               ? (atQuery.query ? t("chat.searchingAll") : t("chat.indexTruncated"))
              : "";
            return (
              <div
                ref={atMenuRef}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: "calc(100% + 8px)",
                  zIndex: 120,
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-lg)",
                  boxShadow: "var(--shadow-overlay)",
                  overflow: "hidden",
                  boxSizing: "border-box",
                  display: "flex",
                  flexDirection: "column",
                  maxHeight: atMenuMaxHeight === null
                    ? "min(48vh, 400px)"
                    : `min(48vh, 400px, ${atMenuMaxHeight}px)`,
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: "var(--font-size-sm)",
                    color: "var(--text-dim)",
                    flexShrink: 0,
                  }}
                >
                  <span>
                    {indexLoading
                       ? t("chat.loadingFiles")
                       : t("chat.files", { label: matchCountLabel, hint: truncatedHint })}
                  </span>
                   <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
                </div>
                <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 4 }}>
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: "var(--font-size-sm)", color: "var(--text-dim)" }}>
                       {needsServerSearch && !serverResultInUse ? t("chat.searching") : t("chat.noMatchingFiles")}
                    </div>
                  ) : (
                    atMatches.map((entry, index) => {
                      const active = index === atActiveIndex;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(entry);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: "var(--radius-sm)",
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: "var(--font-size-sm)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                            {name}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
          {/* Surface chrome (bg/border/radius/padding/shadow + hover and
              focus-within states) lives in conversation.css, catalog §1.1
              verbatim; bash mode tags the element for the CSS border state. */}
          <div
            className={compact ? undefined : "chat-composer-surface"}
            data-bash-mode={bashMode && !compact ? "true" : undefined}
            style={{
              minWidth: 0,
              display: "flex",
              flexDirection: compact && !stackedComposer ? "row" : "column",
              gap: 8,
              alignItems: stackedComposer ? "stretch" : "center",
              ...(compact ? { background: "transparent", border: "none", borderRadius: 0, padding: 0, boxShadow: "none" } : {}),
            } as React.CSSProperties}
          >
          <textarea
            ref={textareaRef}
            className="chat-input-textarea"
            aria-label={compact ? t("chat.quoteQuestion") : undefined}
            value={value}
            onChange={(e) => {
              valueRef.current = e.target.value;
              setValue(e.target.value);
              setHistoryMenuOpen(false);
              updateAtQuery(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onPaste={handlePaste}
            placeholder={
              isCompacting
                ? t("chat.compactingPlaceholder")
                : isStreaming && (onSteer || onFollowUp)
                ? t("chat.steerPlaceholder")
                : isStreaming ? t("chat.agentPlaceholder")
                : t("chat.messagePlaceholder")
            }
            rows={1}
            style={{
              flex: stackedComposer ? "none" : 1,
              minWidth: 0,
              width: "100%",
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: "var(--chat-content-font-size, 16px)",
              lineHeight: 1.6,
              fontFamily: "inherit",
              minHeight: compact ? 96 : 52,
              maxHeight: 200,
              overflow: "auto",
            }}
          />

          {compact && composerSubmitControl}
        {/* Bottom bar: left | center (context) | right — the §1.5 toolbar row:
            leading cluster rides a 4px gap, the trailing one 6px. */}
        {!compact && <div className="chat-input-controls" style={{
          marginTop: isMobile ? 4 : 8,
          display: isMobile ? "grid" : "flex",
          gridTemplateColumns: isMobile ? "minmax(0, 1fr) auto" : undefined,
          alignItems: "center",
          gap: 4,
        }}>

          {/* LEFT: attach + model selector (idle) or steer/followup toggle (streaming) */}
          <div style={{ flex: isMobile ? "1 1 auto" : "0 0 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 4 }}>
            <button
              type="button"
              className="composer-toolbar-button"
              onClick={() => fileInputRef.current?.click()}
              title={t("chat.attachFiles")}
              aria-label={t("chat.attachFiles")}
              style={{ padding: 0, width: 28 }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14" />
                <path d="M12 5v14" />
              </svg>
            </button>
            {/* Model selector - visible always, disabled while the session or switch is busy */}
            {(modelOptions.length > 0 || model || modelError) && onModelChange && (
              <ModelSelector
                options={modelOptions}
                value={model}
                onChange={onModelChange}
                onReselect={onModelChange}
                disabled={isStreaming}
                busy={modelSwitching}
                isAutoSelection={isAutoModelSelection}
                defaultValue={defaultModel}
                onSetDefault={onSetDefaultModel}
              />
            )}
            {leadingAction}
          </div>

          {/* spacer */}
          {!isMobile && <div style={{ flex: 1 }} />}

          {/* RIGHT: reasoning + sound (idle) | Stop + sound (streaming) */}
          <div ref={controlsMenuRef} style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            position: "relative",
            marginLeft: isMobile ? 0 : "auto",
            gap: 6,
          }}>
            {isMobile && (
              <button
                type="button"
                 title={controlsMenuOpen ? undefined : t("chat.moreControls")}
                 aria-label={t("chat.moreControls")}
                aria-expanded={controlsMenuOpen}
                aria-hidden={controlsMenuOpen || undefined}
                tabIndex={controlsMenuOpen ? -1 : undefined}
                onClick={() => {
                  setControlsMenuOpen(true);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "100%",
                  height: 32,
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  borderRadius: "var(--radius-md)",
                  color: "var(--text-muted)",
                  cursor: controlsMenuOpen ? "default" : "pointer",
                  fontSize: "var(--font-size-sm)",
                  fontWeight: 500,
                  visibility: controlsMenuOpen ? "hidden" : "visible",
                  pointerEvents: controlsMenuOpen ? "none" : "auto",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  if (controlsMenuOpen) return;
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                }}
                onMouseLeave={(e) => {
                  if (controlsMenuOpen) return;
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                {t("chat.moreControls")}
              </button>
            )}
            <div style={{
              display: isMobile ? (controlsMenuOpen ? "flex" : "none") : "flex",
              alignItems: "center",
              gap: isMobile ? 1 : 2,
              ...(isMobile ? {
                position: "absolute",
                right: 0,
                bottom: 0,
                zIndex: 60,
                padding: 1,
                width: "max-content",
                maxWidth: "calc(100vw - 32px)",
                flexWrap: "nowrap",
                justifyContent: "flex-end",
                border: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                borderRadius: "var(--radius-lg)",
                background: "color-mix(in srgb, var(--bg-panel) 92%, var(--bg))",
                boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
                backdropFilter: "blur(10px)",
              } : null),
            }}>
            {onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <button
                  type="button"
                  data-thinking-selector-trigger="true"
                  className="composer-toolbar-button"
                  onClick={() => setThinkingDropdownOpen((v) => !v)}
                  title={isStreaming
                    ? t("chat.currentReasoning", { level: thinkingDisplayLabel })
                    : t("chat.changeReasoning", { level: thinkingDisplayLabel })}
                  aria-label={t("chat.changeReasoningLabel")}
                  aria-expanded={thinkingDropdownOpen}
                >
                  {/* Reasoning control (§1.5): BrainIcon 16px, label, 14px
                      chevron-down in the subtle ink — verbatim lucide. */}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 18V5" />
                    <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
                    <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
                    <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
                    <path d="M18 18a4 4 0 0 0 2-7.464" />
                    <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
                    <path d="M6 18a4 4 0 0 1-2-7.464" />
                    <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
                  </svg>
                  {(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>{thinkingDisplayLabel}</span>}
                  <svg className="composer-toolbar-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
                {thinkingDropdownOpen && (
                  <div className="composer-pop" style={{
                    position: "absolute", bottom: "calc(100% + 6px)",
                    ...(isMobile ? { left: 0 } : { right: 0 }),
                    zIndex: 100, background: "var(--popover)", border: "1px solid var(--border)",
                    borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-overlay)",
                    overflow: "hidden", minWidth: 180,
                  }}>
                    {THINKING_LEVELS.filter((lvl) => {
                      if (thinkingSearch && !`${lvl} ${t(THINKING_LEVEL_DESC_KEYS[lvl])}`.toLocaleLowerCase().includes(thinkingSearch.toLocaleLowerCase())) return false;
                      if (!availableThinkingLevels) return true;
                      if (lvl === "auto") return true;
                      return availableThinkingLevels.includes(lvl);
                    }).map((lvl) => {
                      const isActive = lvl === "auto"
                        ? isAutoThinkingSelection
                        : !isAutoThinkingSelection && resolvedThinkingLevel === lvl;
                      const desc = t(THINKING_LEVEL_DESC_KEYS[lvl]);
                      const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                      const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                      const showOriginal = mappedVal != null && mappedVal !== lvl;
                      return (
                        <SelectorRow
                          key={lvl}
                          active={isActive}
                          onSelect={() => {
                            setThinkingDropdownOpen(false);
                            if (lvl === "auto") {
                              if (!isAutoThinkingSelection) onThinkingLevelChange("auto");
                              return;
                            }
                            if (!isActive || isAutoThinkingSelection) onThinkingLevelChange(lvl);
                          }}
                          gutter={Boolean(onSetDefaultThinkingLevel)}
                          star={onSetDefaultThinkingLevel && lvl !== "auto"
                            ? {
                                isDefault: savedDefaultThinkingLevel === lvl,
                                saveLabel: t("chat.saveDefaultThinking"),
                                defaultLabel: t("chat.defaultThinking"),
                                onSave: () => {
                                  setThinkingDropdownOpen(false);
                                  onSetDefaultThinkingLevel(lvl);
                                },
                              }
                            : undefined}
                        >
                          <span style={{ flex: 1 }}>
                            {displayLabel}
                            {showOriginal && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 5 }}>({lvl})</span>}
                          </span>
                          <span style={{ fontSize: "var(--font-size-sm)", color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </SelectorRow>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {isStreaming && (
              <button
                type="button"
                className="composer-stop"
                onClick={onAbort}
                title={t("chat.stopAgent")}
                aria-label={t("chat.stopAgent")}
              >
                {/* §1.3 verbatim: the solid Square (fill-current), 16px. */}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                </svg>
              </button>
            )}

            {onSoundToggle !== undefined && (
              <button
                type="button"
                className="composer-toolbar-button"
                onClick={onSoundToggle}
                title={soundEnabled ? t("chat.disableSound") : t("chat.enableSound")}
                aria-label={soundEnabled ? t("chat.disableSound") : t("chat.enableSound")}
                aria-pressed={soundEnabled}
                style={{ padding: 0, width: 28, opacity: soundEnabled ? 1 : 0.55 }}
              >
                {soundEnabled ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                )}
              </button>
            )}
            {isMobile && controlsMenuOpen && (
              <button
                type="button"
                 title={t("chat.collapseControls")}
                 aria-label={t("chat.collapseControls")}
                aria-expanded={true}
                onClick={() => {
                  setThinkingDropdownOpen(false);
                  setControlsMenuOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 36,
                  height: 32,
                  padding: 0,
                  marginLeft: 0,
                  background: "var(--bg-hover)",
                  border: "none",
                  borderLeft: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                  borderRadius: "0 9px 9px 0",
                  color: "var(--text)",
                  cursor: "pointer",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
            </div>
          </div>

          {composerSubmitControl}
        </div>}
          </div>
        </div>

        {/* Bash mode status label */}
        {bashMode && (
          <div className="px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4, fontSize: "var(--font-size-xs)" }}>
             {t("chat.shell")} · {bashExcluded ? t("chat.outputLocal") : t("chat.outputModel")}
          </div>
        )}


      </div>
    </fieldset>
  );
}));
