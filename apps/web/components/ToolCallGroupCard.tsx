"use client";

import { useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useDelayedUnmount } from "@/hooks/useDelayedUnmount";
import { isToolCallExpanded, setToolCallExpanded } from "@/lib/tool-call-expansion";
import { ChevronRightIcon, SquareTerminalIcon, PencilIcon, SearchIcon, toolIconFor, type IconComponent } from "./tool-icons";
import { TOOL_COLLAPSE_UNMOUNT_DELAY_MS } from "./ConversationTool";

/**
 * ZCode's consecutive-call merge (user order 2026-10-31: 多次调用之间看不出
 * 来 — ConversationTurnGroup's executeGroup/changesGroup/exploreGroup): a run
 * of same-family tool calls renders as ONE row while collapsed; expanding
 * reveals the calls as rail children (ml-2 border-l pl-3.5 space-y-2, ZCode's
 * §2.5/§8.1 nesting), each still individually expandable. Children drop their
 * leading icon at depth 1, as ZCode's nestedToolRenderer does.
 *
 * The summary uses ZCode's vocabulary of what the run did, not a bare count:
 * "查阅 · 1 搜索, 1 文件", "终端 · 3 个命令" (screenshot order 2026-10-31).
 */

const FAMILY_ICON = { terminal: SquareTerminalIcon, changes: PencilIcon, explore: SearchIcon } as const;
export type ToolCallFamily = keyof typeof FAMILY_ICON;

/** Which merge family a tool belongs to, by the icon it renders (null = never group).
 *  The changes family (write/edit/patch) collapses to 更改 · N 个文件; the
 *  children keep their 编辑 kind + file chip + diff counts. */
export function toolCallFamily(name: string): ToolCallFamily | null {
  const icon = toolIconFor(name);
  for (const key of Object.keys(FAMILY_ICON) as ToolCallFamily[]) {
    if (icon === FAMILY_ICON[key]) return key;
  }
  return null;
}

export interface ToolCallRunCounts {
  /** explore only: search/glob/grep calls. */
  searches: number;
  /** explore/changes: file calls (read / write / edit). */
  files: number;
  /** terminal: executed commands. */
  commands: number;
}

/** Count a run's calls for its collapsed summary line. */
export function countToolCallRun(family: ToolCallFamily, names: readonly string[]): ToolCallRunCounts {
  let searches = 0;
  let files = 0;
  for (const name of names) {
    if (family === "explore") {
      if (toolIconFor(name) === SearchIcon && !/^(read|read_file|readfile)$/i.test(name)) searches += 1;
      else files += 1;
    } else {
      files += 1;
    }
  }
  return { searches, files, commands: names.length };
}

export function ToolCallGroupCard({ family, label, counts, groupKey, children }: {
  family: ToolCallFamily;
  label: string;
  counts: ToolCallRunCounts;
  /** Stable expansion key: `group:${firstCallId}`. */
  groupKey: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() => isToolCallExpanded(groupKey));
  const childrenRendered = useDelayedUnmount(expanded, TOOL_COLLAPSE_UNMOUNT_DELAY_MS);
  const Icon = FAMILY_ICON[family];
  const parts = family === "terminal"
    ? [t("chat.toolGroup.commands", { count: counts.commands })]
    : family === "changes"
      ? [t("chat.toolGroup.changes", { count: counts.files })]
      : [
          counts.searches > 0 ? t("chat.toolGroup.searches", { count: counts.searches }) : null,
          counts.files > 0 ? t("chat.toolGroup.files", { count: counts.files }) : null,
        ].filter((part): part is string => part !== null);
  const summary = parts.join(", ");
  return (
    <div className="tool-call-group">
      <button
        type="button"
        className="tool-summary"
        aria-expanded={expanded}
        aria-label={`${label} · ${summary}`}
        onClick={() => {
          setExpanded(!expanded);
          setToolCallExpanded(groupKey, !expanded);
        }}
      >
        <span className="tool-glyph-slot"><Icon size={16} /></span>
        <span className="tool-kind">{label}</span>
        {summary !== "" && (
          <>
            <span className="tool-separator">·</span>
            <span className="tool-summary-text">{summary}</span>
          </>
        )}
        <ChevronRightIcon size={16} className="tool-chevron" />
      </button>
      {childrenRendered && (
        <div className="tool-call-group-children pi-disclose" data-open={expanded} inert={!expanded || undefined}>
          <div className="pi-disclose-body">{children}</div>
        </div>
      )}
    </div>
  );
}
