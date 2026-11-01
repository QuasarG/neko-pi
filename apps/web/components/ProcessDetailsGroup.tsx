"use client";

import { useLayoutEffect, useState, type ReactNode } from "react";
import { formatTurnDuration } from "@/lib/turn-duration";
import type { CacheMissSummary } from "@/lib/transcript-notices";
import { cacheMissSummaryText } from "@/components/TranscriptNotices";
import { ChevronRightIcon } from "./tool-icons";
import { useDelayedUnmount } from "@/hooks/useDelayedUnmount";

/** ZCode's AssistantHistoryStatus band: the fold under a turn's work. Shared
 * by the main conversation (ChatWindow) and the subagent viewer (R47: a
 * child's transcript folds the same way its parent's does). */
export const PROCESS_DETAILS_UNMOUNT_DELAY_MS = 260;

export function ProcessDetailsGroup({ messageCount, toolCallCount, durationMs, cacheMisses, defaultExpanded = false, reveal = false, children, t }: { messageCount: number; toolCallCount: number; durationMs?: number; cacheMisses?: CacheMissSummary; defaultExpanded?: boolean; reveal?: boolean; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  useLayoutEffect(() => {
    if (reveal) setExpanded(true);
  }, [reveal]);
  const open = expanded || reveal;
  // The fold's content stays mounted for the collapse animation, as ZCode's
  // delayed unmount does; the CSS 180ms transition clears inside the window.
  const bodyRendered = useDelayedUnmount(open, PROCESS_DETAILS_UNMOUNT_DELAY_MS);
  // The counts are details now, not a visible sentence.
  const parts = [`${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);
  if (durationMs !== undefined) parts.push(t("chat.turnDuration", { time: formatTurnDuration(durationMs) }));
  // Folded, the cache misses inside are added up here (#1265); open, each shows under its step.
  const cacheMissText = cacheMisses && !open ? cacheMissSummaryText(t, cacheMisses) : undefined;
  const countsText = [...parts, ...(cacheMissText ? [cacheMissText] : [])].join(" · ");
  const label = durationMs !== undefined
    ? t("chat.workedFor", { time: formatTurnDuration(durationMs) })
    : t("chat.worked");

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        paddingBottom: 8,
        borderBottom: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
        // ZCode's turn rhythm: 20px between the band and the answer.
        marginBottom: 20,
      }}
    >
      <button
        type="button"
        className="process-details-trigger"
        aria-expanded={open}
        aria-label={`${t("chat.processDetails")} · ${countsText}`}
        title={countsText}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          maxWidth: "100%",
          minWidth: 0,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--conversation-ink-subtle)",
          cursor: "pointer",
          fontSize: "var(--conversation-font-size, 16px)",
          textAlign: "left",
        }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
        <ChevronRightIcon size={16} className="process-details-chevron" />
      </button>
      {bodyRendered && (
        <div className="process-details-body pi-disclose" data-open={open} inert={!open || undefined}>
          <div className="pi-disclose-body">
            {/* pt-5 lives here, not on the animation node: padding on the node
                survives the 0fr collapse until the delayed unmount. */}
            <div className="process-details-inner">{children}</div>
          </div>
        </div>
      )}
    </div>
  );
}
