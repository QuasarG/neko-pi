"use client";

import { stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { AnsiText } from "./AnsiText";
import { ExtensionWidgets } from "./ExtensionWidgets";

/**
 * `ctx.ui.setStatus("command:/mode toggle", "Build")` shows "Build" as a button
 * that sends `/mode toggle`. The command lives in the key because setStatus has
 * no room for it, and Pi's own footer prints only the text, so the same status
 * is still plain text there.
 */
export const EXTENSION_STATUS_COMMAND_PREFIX = "command:";

/** The slash command a status key asks for, or null for an ordinary status. */
export function extensionStatusCommand(key: string): string | null {
  if (!key.startsWith(EXTENSION_STATUS_COMMAND_PREFIX)) return null;
  const command = key.slice(EXTENSION_STATUS_COMMAND_PREFIX.length).trim();
  return command.length > 1 && command.startsWith("/") ? command : null;
}

export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/ +/g, " ").trim())
    .join("\n")
    .trim();
}

/** The `goal` status line parsed back into the runtime goal projection. */
export interface GoalStatusProjection {
  rounds: number;
  maxRounds: number;
  /** Loop status from the goal row: "active" | "paused" (terminal states clear the line). */
  status: string;
  objective: string;
}

/**
 * Parses the line written by formatGoalStatusText
 * (packages/coding-agent/src/extensions/goal/index.ts) — the runtime goal row
 * pushed through the status channel, not text guessed from messages. Returns
 * null for anything else (e.g. a pre-projection "goal 3/20" line), which the
 * bar then renders as plain text.
 */
export function parseGoalStatusText(text: string): GoalStatusProjection | null {
  const match = text.trim().match(/^goal (\d+)\/(\d+) ([a-z-]+) (.+)$/);
  if (!match) return null;
  return {
    rounds: Number(match[1]),
    maxRounds: Number(match[2]),
    status: match[3],
    objective: match[4],
  };
}

/** Loop-status word the bar shows; unknown statuses pass through untranslated. */
export function goalStatusWord(status: string, t: (key: string) => string): string {
  if (status === "active") return t("chat.goalStatusActive");
  if (status === "paused") return t("chat.goalStatusPaused");
  return status;
}

/**
 * R19(c): the goal line's placement is the top-right status card, not a strip
 * by the composer. The host splits the statuses here — a parseable goal line
 * leaves the bar (the card owns it), an unparseable one stays as an ordinary
 * text cell so the raw line is still shown somewhere.
 */
export function extractGoalStatus(statuses: ExtensionStatusItem[]): {
  goal: GoalStatusProjection | null;
  statuses: ExtensionStatusItem[];
} {
  const goal = statuses.find((status) => status.key === "goal");
  if (!goal) return { goal: null, statuses };
  const projection = parseGoalStatusText(stripAnsi(goal.text));
  if (!projection) return { goal: null, statuses };
  return { goal: projection, statuses: statuses.filter((status) => status.key !== "goal") };
}

function sortedStatuses(statuses: ExtensionStatusItem[]): ExtensionStatusItem[] {
  return [...statuses].sort((a, b) => a.key.localeCompare(b.key));
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return sortedStatuses(statuses)
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");
}

type StatusCell =
  | { kind: "text"; text: string }
  | { kind: "command"; command: string; label: string };

/** One cell per status, in key order. A status with nothing visible to show has no cell. */
export function buildExtensionStatusCells(statuses: ExtensionStatusItem[]): StatusCell[] {
  const cells: StatusCell[] = [];
  for (const item of sortedStatuses(statuses)) {
    const text = sanitizeExtensionStatusText(item.text);
    const command = extensionStatusCommand(item.key);
    if (command) {
      const label = stripAnsi(text).replace(/\s+/g, " ").trim();
      cells.push({ kind: "command", command, label: label || command });
    } else if (stripAnsi(text).trim()) {
      cells.push({ kind: "text", text });
    }
  }
  return cells;
}

export function ExtensionStatusBar({
  statuses,
  widgets = [],
  onCommand,
  commandsDisabled = false,
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  /** Sends the command of a `command:` status; without it those buttons stay disabled. */
  onCommand?: (command: string) => void;
  commandsDisabled?: boolean;
}) {
  const cells = buildExtensionStatusCells(statuses);
  if (cells.length === 0 && widgets.length === 0) return null;

  const hasCommands = cells.some((cell) => cell.kind === "command");
  const plainStatusLine = cells
    .map((cell) => (cell.kind === "text" ? stripAnsi(cell.text) : cell.label))
    .join(" ");

  const statusLine = cells.length > 0 ? (
    <div
      role="status"
      className="extension-status-line"
      aria-label={plainStatusLine}
      title={plainStatusLine}
    >
      <span className="extension-status-text">
        {cells.map((cell, index) => cell.kind === "text" ? (
          <span key={index} className="extension-status-item">
            <AnsiText text={cell.text} />
          </span>
        ) : (
          <button
            key={index}
            type="button"
            className="extension-status-item extension-status-command"
            disabled={!onCommand || commandsDisabled}
            title={`${cell.label} · ${cell.command}`}
            aria-label={`${cell.label} (${cell.command})`}
            onClick={() => onCommand?.(cell.command)}
          >
            {cell.label}
          </button>
        ))}
      </span>
    </div>
  ) : null;

  return (
    <div
      className={`extension-status-shelf${widgets.length > 0 ? " has-widgets" : ""}${cells.length > 0 ? " has-status" : ""}${hasCommands ? " has-commands" : ""}`}
    >
      {widgets.length > 0 ? <ExtensionWidgets widgets={widgets}>{statusLine}</ExtensionWidgets> : statusLine}
    </div>
  );
}
