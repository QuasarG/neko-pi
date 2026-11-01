"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useDelayedUnmount } from "@/hooks/useDelayedUnmount";
import { copyText } from "@/lib/clipboard";
import {
  codemodeTotalCost,
  formatCodemodeCost,
  formatCodemodeDuration,
  type CodemodeCallView,
} from "@/lib/codemode-view";
import { isToolCallExpanded, setToolCallExpanded } from "@/lib/tool-call-expansion";
import { ToolErrorStatus, TOOL_COLLAPSE_UNMOUNT_DELAY_MS } from "./ConversationTool";
import { ChevronRightIcon } from "./tool-icons";

// The tool calls a codemode script made, listed under the script in its card
// (§8.3): each is a nested row with the same anatomy as a top-level tool call
// — kind label, truncating summary, hover chevron, 300ms collapsible detail —
// inside the child rail, and with no leading icon at depth 1, as ZCode's
// nested tool lists render. Those calls never reach the model as tool calls of
// their own, so they are rows inside this card, not separate cards.

/** Calls shown before the rest are folded behind a button; the newest stay visible. */
export const CODEMODE_VISIBLE_CALLS = 20;

/**
 * One nested call as a full expandable tool row. The status is machine-read
 * only (an aria marker, never colored ink — §2.4); a failure also gets the
 * dotted-underline status word whose tooltip carries the error text.
 */
function CallRow({ call }: { call: CodemodeCallView }) {
  const { t } = useI18n();
  const expansionId = call.id || undefined;
  const [expanded, setExpanded] = useState(() => isToolCallExpanded(expansionId));
  const detailRendered = useDelayedUnmount(expanded, TOOL_COLLAPSE_UNMOUNT_DELAY_MS);
  const duration = formatCodemodeDuration(call.durationMs);
  const statusKey = `codemode.status.${call.status}`;
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    setToolCallExpanded(expansionId, next);
  };
  return (
    <li className="codemode-call" data-status={call.status}>
      <button type="button" className="tool-summary" aria-expanded={expanded} onClick={toggle}>
        {call.status !== "ok" && (
          <span role="img" aria-label={t(statusKey)} title={t(statusKey)} className="codemode-call-status" />
        )}
        <span className={`tool-kind codemode-call-name${call.status === "running" ? " animated-gradient-text" : ""}`}>{call.name}</span>
        <span className="tool-summary-text">{call.args}</span>
        {duration && <span className="tool-status">{duration}</span>}
        {call.cost !== undefined && <span className="tool-status">{formatCodemodeCost(call.cost)}</span>}
        {call.status === "error" && call.error && <ToolErrorStatus errorText={call.error} />}
        <ChevronRightIcon size={16} className="tool-chevron" />
      </button>
      {detailRendered && (
        <div className="tool-detail pi-disclose" data-open={expanded} inert={!expanded || undefined}>
          <div className="pi-disclose-body">
            {call.args && <pre className="codemode-call-args">{call.args}</pre>}
            {call.error && (
              <div className="codemode-call-error">
                <span className="codemode-call-error-head">{t(statusKey)}</span>
                <pre className="codemode-call-error-text">{call.error}</pre>
                <button
                  type="button"
                  className="codemode-call-error-copy"
                  onClick={() => { void copyText(call.error ?? ""); }}
                >
                  {t("i18n.copy")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function CodemodeCallList({ calls, omitted }: {
  calls: readonly CodemodeCallView[];
  /** Earlier calls a progress snapshot did not include. */
  omitted: number;
}) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  if (calls.length === 0 && omitted === 0) return null;
  const hidden = showAll ? 0 : Math.max(0, calls.length - CODEMODE_VISIBLE_CALLS);
  const shown = hidden > 0 ? calls.slice(hidden) : calls;
  // Folded rows still count: the total covers every call the result lists.
  const totalCost = codemodeTotalCost(calls);
  return (
    <div className="codemode-calls">
      <div className="codemode-calls-head">{t("codemode.calls")}</div>
      {omitted > 0 && (
        <div className="codemode-calls-note">{t("codemode.omittedCalls", { count: omitted })}</div>
      )}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          style={{ alignSelf: "flex-start", padding: 0, border: "none", background: "none", color: "var(--accent)", cursor: "pointer", font: "inherit" }}
        >
          {t("codemode.showEarlierCalls", { count: hidden })}
        </button>
      )}
      {/* The child rail (§2.5/§8.1): ml-2, a 1px left border, pl-3.5, 8px rhythm. */}
      <ul className="codemode-calls-list">
        {shown.map((call, index) => (
          <CallRow key={call.id || `${hidden + index}`} call={call} />
        ))}
      </ul>
      {totalCost !== null && (
        <div className="codemode-calls-note">{t("codemode.modelCost", { cost: formatCodemodeCost(totalCost) })}</div>
      )}
    </div>
  );
}
