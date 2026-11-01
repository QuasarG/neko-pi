"use client";

import { useMemo } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ActivityIcon, BotIcon, SquareTerminalIcon, WorkflowIcon } from "./tool-icons";

/* ZCode's ConversationBackgroundWorkTrigger (catalog A.1), ported as anatomy:
 * the composer's leading-actions badge with per-type icons (size-3.5) and
 * counts, compacting to ActivityIcon + total under 480px of composer width.
 * Our runtime has no workflow kind — the counter keeps the branch so the day
 * one arrives the badge already counts it, but it can only read zero today. */

export interface ComposerBackgroundWorkCounts {
  bashCount: number;
  workflowCount: number;
  subagentCount: number;
  totalCount: number;
}

export function getComposerBackgroundWorkCounts(
  runningBashCount: number,
  runningSubagentCount = 0,
  runningWorkflowCount = 0,
): ComposerBackgroundWorkCounts {
  const bashCount = Math.max(0, runningBashCount);
  const subagentCount = Math.max(0, runningSubagentCount);
  const workflowCount = Math.max(0, runningWorkflowCount);
  return {
    bashCount,
    workflowCount,
    subagentCount,
    totalCount: bashCount + workflowCount + subagentCount,
  };
}

export function composerBackgroundWorkTooltipKey(counts: ComposerBackgroundWorkCounts): string {
  // Exactly one kind speaks its own word; mixtures get the mixed word — three
  // pairwise combinations would only pile up synonymous tooltips.
  const activeKindCount = [counts.bashCount, counts.workflowCount, counts.subagentCount].filter(
    (count) => count > 0,
  ).length;
  if (activeKindCount > 1) return "chat.composer.backgroundWorks.tooltipMixed";
  if (counts.bashCount > 0) return "chat.composer.backgroundWorks.tooltipTerminal";
  if (counts.workflowCount > 0) return "chat.composer.backgroundWorks.tooltipWorkflow";
  return "chat.composer.backgroundWorks.tooltipAgent";
}

export function BackgroundWorkBadges({
  runningBashCount,
  runningSubagentCount = 0,
  onOpen,
}: {
  runningBashCount: number;
  runningSubagentCount?: number;
  /** Absent handler → no badge (ZCode: `if (!onOpen || totalCount === 0) return null`). */
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  const counts = useMemo(
    () => getComposerBackgroundWorkCounts(runningBashCount, runningSubagentCount),
    [runningBashCount, runningSubagentCount],
  );

  if (!onOpen || counts.totalCount === 0) return null;

  const tooltip = t(composerBackgroundWorkTooltipKey(counts));
  const ariaLabel = t("chat.composer.backgroundWorks.ariaLabel", {
    bashCount: counts.bashCount,
    subagentCount: counts.subagentCount,
    count: counts.totalCount,
  });

  return (
    <button
      type="button"
      data-testid="v4-composer-background-work-trigger"
      data-background-bash-count={counts.bashCount}
      data-background-workflow-count={counts.workflowCount}
      data-background-subagent-count={counts.subagentCount}
      data-background-total-count={counts.totalCount}
      data-background-open-target="panel"
      className="composer-background-badge"
      aria-label={ariaLabel}
      title={tooltip}
      onClick={onOpen}
    >
      <span data-composer-background-layout="typed" className="composer-background-typed" aria-hidden="true">
        {/* Terminal first — the visual order from before the workflow split;
            workflow slots between terminal and agent. */}
        {counts.bashCount > 0 ? (
          <span className="composer-background-kind">
            <SquareTerminalIcon size={14} />
            <span>{counts.bashCount}</span>
          </span>
        ) : null}
        {counts.workflowCount > 0 ? (
          <span className="composer-background-kind">
            <WorkflowIcon size={14} />
            <span>{counts.workflowCount}</span>
          </span>
        ) : null}
        {counts.subagentCount > 0 ? (
          <span className="composer-background-kind">
            <BotIcon size={14} />
            <span>{counts.subagentCount}</span>
          </span>
        ) : null}
      </span>
      <span data-composer-background-layout="compact" className="composer-background-compact" aria-hidden="true">
        <ActivityIcon size={14} />
        <span>{counts.totalCount}</span>
      </span>
    </button>
  );
}
