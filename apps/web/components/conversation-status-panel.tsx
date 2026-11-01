"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { GoalStatusProjection } from "./ExtensionStatusBar";
import {
  ActivityIcon,
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleIcon,
  EllipsisIcon,
  GoalIcon,
  ListChecksIcon,
  Maximize2Icon,
  Minimize2Icon,
  PauseIcon,
  PlayIcon,
  SquareTerminalIcon,
} from "./tool-icons";

/* ZCode's ConversationStatusPanel (catalog recon-panels-todo-card.md, Surface
 * C), ported as ANATOMY (R18): same DOM structure, class anatomy, icon
 * geometry and timings, fed by our payloads through the adapter table at the
 * back of the catalog. What our runtime has no data for is honestly absent:
 * no Git section, no session plans, no workflows (levels 1/4/5/8/10 of the
 * pill chain cannot fire — see the wave report), and the Goal section has no
 * elapsed timer (the projection line carries no startedAt; extending it would
 * change T4's pinned transport format, so the trade-off ruling was CUT). */

export type StatusPanelVariant = "auto" | "panel" | "mini";

/** Our background job shape, already mapped at the host (catalog DATA ADAPTER:
 * BackgroundJob{id,kind,label,startedAt,status} → workId/title/startedAt). */
export interface StatusPanelWork {
  workId: string;
  kind: "bash" | "subagent";
  title: string;
  startedAt: number;
}

/** One running subagent (session family row; startedAt is coarse — session
 * modified time — per the catalog's adapter note). */
export interface StatusPanelSubagent {
  childSessionId: string;
  title: string;
  startedAt: number | null;
}

/** A todo item as the latest todo_write block wrote it, in snapshot order. */
export interface StatusPanelTodoItem {
  id: string;
  content: string;
  status: "completed" | "inProgress" | "pending";
}

export interface StatusPanelModel {
  hasContent: boolean;
  goal: GoalStatusProjection | null;
  plan: { items: StatusPanelTodoItem[]; completedCount: number; totalCount: number } | null;
  runningBashWorks: StatusPanelWork[];
  runningSubagents: StatusPanelSubagent[];
}

/** The panel model (C.2 mount gates): only RUNNING works show; a goal line on
 * screen is by construction a live loop (terminal states clear it); a todo
 * list with no items is not a plan. */
export function buildStatusPanelModel({
  goal,
  todoItems,
  works,
  subagents,
}: {
  goal: GoalStatusProjection | null;
  todoItems: StatusPanelTodoItem[];
  works: StatusPanelWork[];
  subagents: StatusPanelSubagent[];
}): StatusPanelModel {
  const items = todoItems.filter((item) => item.content.trim().length > 0);
  const completedCount = items.filter((item) => item.status === "completed").length;
  const runningBashWorks = works.filter((work) => work.kind === "bash");
  return {
    hasContent: Boolean(
      goal || items.length > 0 || runningBashWorks.length > 0 || subagents.length > 0,
    ),
    goal,
    plan: items.length > 0 ? { items, completedCount, totalCount: items.length } : null,
    runningBashWorks,
    runningSubagents: subagents,
  };
}

/* ── Elapsed vocabulary (A.3/C.5) ────────────────────────────────────────── */

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The work row's label — `已运行 {minutes} 分 {seconds} 秒` style; a finished
 * or missing duration still reads as one second (ZCode's max(1, …)). */
export function formatBackgroundTaskElapsedLabel(elapsedMs: number, t: Translate): string {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes > 0) {
    return t("chat.longRunning.elapsedMinutesSeconds", { minutes, seconds: totalSeconds % 60 });
  }
  return t("chat.longRunning.elapsedSeconds", { seconds: totalSeconds });
}

/** The collapsed section header's `1小时 2分 3秒` units form (C.5): zero parts
 * drop, an all-zero value reads as "0秒". */
export function formatDurationUnits(totalSeconds: number, t: Translate): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}${t("chat.summaryPanel.duration.hours")}`);
  if (minutes > 0) parts.push(`${minutes}${t("chat.summaryPanel.duration.minutes")}`);
  if (restSeconds > 0 || parts.length === 0) {
    parts.push(`${restSeconds}${t("chat.summaryPanel.duration.seconds")}`);
  }
  return parts.join(" ");
}

/** One shared 1s clock while anything ticks (elapsed labels), boolean-driven
 * like ZCode's useNowTicker so a projection refresh never re-arms it. */
function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/* ── Todo focus window (C.4, constants verbatim) ─────────────────────────── */

export const COMPACT_TODO_THRESHOLD = 6;
export const TODO_FOCUS_WINDOW_SIZE = 3;

export interface StatusPanelTodoFocusWindow {
  compact: boolean;
  precedingItems: StatusPanelTodoItem[];
  focusItems: StatusPanelTodoItem[];
  followingItems: StatusPanelTodoItem[];
}

/** >6 items → a 3-item window around the current item (first inProgress, else
 * first unfinished, else the last three), backfilled from the front so the
 * window stays three wide near the list's end, never reordered. */
export function getStatusPanelTodoFocusWindow(items: StatusPanelTodoItem[]): StatusPanelTodoFocusWindow {
  if (items.length <= COMPACT_TODO_THRESHOLD) {
    return { compact: false, precedingItems: [], focusItems: items, followingItems: [] };
  }
  const runningIndex = items.findIndex((item) => item.status === "inProgress");
  const firstUnfinishedIndex = items.findIndex((item) => item.status !== "completed");
  const focusIndex =
    runningIndex >= 0
      ? runningIndex
      : firstUnfinishedIndex >= 0
        ? firstUnfinishedIndex
        : Math.max(0, items.length - TODO_FOCUS_WINDOW_SIZE);
  const focusStartIndex = Math.max(0, Math.min(focusIndex, items.length - TODO_FOCUS_WINDOW_SIZE));
  const focusEndIndex = Math.min(items.length, focusStartIndex + TODO_FOCUS_WINDOW_SIZE);
  return {
    compact: true,
    precedingItems: items.slice(0, focusStartIndex),
    focusItems: items.slice(focusStartIndex, focusEndIndex),
    followingItems: items.slice(focusEndIndex),
  };
}

/* ── Mini pill priority chain (C.6) ──────────────────────────────────────── */

export type StatusSummarySelection =
  | { kind: "currentTodo"; content: string }
  | { kind: "activeGoal"; title: string }
  | { kind: "completedTodo"; content: string }
  | { kind: "todoCounter"; completedCount: number; totalCount: number }
  | { kind: "runningWorks"; bashCount: number; subagentCount: number };

/** The chain's reachable branches in priority order. Workflow (1), git (4),
 * done-goal (5) and session-plan (8) rows cannot fire on our data: no
 * workflow runtime, no git model input here, and a terminal goal clears the
 * status line before the card ever sees it. */
export function getStatusPanelSummarySelection(model: StatusPanelModel): StatusSummarySelection | null {
  const plan = model.plan;
  const current = plan?.items.find((item) => item.status === "inProgress")
    ?? plan?.items.find((item) => item.status === "pending")
    ?? null;
  if (current) return { kind: "currentTodo", content: current.content };
  const goalTitle = model.goal?.objective.trim() || null;
  // A visible goal line is live (active or paused both mean the loop exists).
  if (goalTitle && model.goal && (model.goal.status === "active" || model.goal.status === "paused")) {
    return { kind: "activeGoal", title: goalTitle };
  }
  const completed = plan ? [...plan.items].reverse().find((item) => item.status === "completed") : null;
  if (completed) return { kind: "completedTodo", content: completed.content };
  if (plan) {
    return { kind: "todoCounter", completedCount: plan.completedCount, totalCount: plan.totalCount };
  }
  const bashCount = model.runningBashWorks.length;
  const subagentCount = model.runningSubagents.length;
  if (bashCount + subagentCount > 0) return { kind: "runningWorks", bashCount, subagentCount };
  return null;
}

/* ── Section chrome (C.3) ────────────────────────────────────────────────── */

type StatusSectionKind = "goal" | "plan" | "terminal" | "agent";

/** Scroll policy table verbatim: null = no inner viewport, the section grows
 * and only the outer p-2 shell scrolls. */
const STATUS_SECTION_SCROLL_POLICY: Record<StatusSectionKind, string | null> = {
  goal: "status-section-scroll-goal", // max-h-48 (192px)
  plan: "status-section-scroll-plan", // max-h-80 (320px — six two-line todos)
  terminal: "status-section-scroll-terminal", // max-h-48
  agent: "status-section-scroll-agent", // max-h-48
};

function StatusSection({
  children,
  defaultOpen = true,
  footer,
  onOpenChange,
  open,
  separated = false,
  section,
  title,
  trailing,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  footer?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  separated?: boolean;
  section: StatusSectionKind;
  title: string;
  trailing?: (isOpen: boolean) => ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = open ?? uncontrolledOpen;
  const toggle = useCallback(() => {
    if (!isControlled) setUncontrolledOpen(!isOpen);
    onOpenChange?.(!isOpen);
  }, [isControlled, isOpen, onOpenChange]);
  const scrollClass = STATUS_SECTION_SCROLL_POLICY[section];

  return (
    // The Collapsible wrapper: separated sections draw the border-t pt-2 rule.
    <div
      data-status-section={section}
      className={`status-section${separated ? " status-section-separated" : ""}`}
    >
      <section className="status-section-inner">
        {/* Header: an h-8 (32px) row. Only the title button toggles — the
            chevron is its hover indicator, the whole row is NOT clickable. */}
        <div className="status-section-header">
          <button
            type="button"
            aria-expanded={isOpen}
            data-status-section-trigger={section}
            className="status-section-trigger"
            onClick={toggle}
          >
            <span className="status-section-title">{title}</span>
            {isOpen ? (
              <ChevronDownIcon size={14} className="status-section-chevron" />
            ) : (
              <ChevronRightIcon size={14} className="status-section-chevron" />
            )}
          </button>
          {trailing ? <div className="status-section-trailing">{trailing(isOpen)}</div> : null}
        </div>
        {/* CollapsibleContent → the pi-disclose height fold; the per-section
            scroll cap lives INSIDE the animated node so the header and footer
            never scroll away. */}
        <div className="pi-disclose" data-open={isOpen ? "true" : "false"}>
          <div className="pi-disclose-body">
            {scrollClass ? (
              <div data-status-section-scroll={section} className={scrollClass}>
                {children}
              </div>
            ) : (
              children
            )}
            {footer}
          </div>
        </div>
      </section>
    </div>
  );
}

/* ── Goal section (C.5, minus the elapsed timer — see header note) ───────── */

function GoalStatusSection({
  goal,
  onGoalCommand,
  separated,
}: {
  goal: GoalStatusProjection;
  onGoalCommand?: (command: "/goal pause" | "/goal resume") => void;
  separated: boolean;
}) {
  const { t } = useI18n();
  const isActive = goal.status === "active";
  const isPaused = goal.status === "paused";
  const control = isActive ? (
    <button
      type="button"
      className="status-icon-button"
      data-goal-action="pause"
      disabled={!onGoalCommand}
      aria-label={t("chat.target.pause")}
      title={t("chat.target.pause")}
      onClick={() => onGoalCommand?.("/goal pause")}
    >
      <PauseIcon size={14} />
    </button>
  ) : isPaused ? (
    <button
      type="button"
      className="status-icon-button"
      data-goal-action="resume"
      disabled={!onGoalCommand}
      aria-label={t("chat.target.resume")}
      title={t("chat.target.resume")}
      onClick={() => onGoalCommand?.("/goal resume")}
    >
      <PlayIcon size={14} />
    </button>
  ) : null;

  return (
    <StatusSection
      section="goal"
      separated={separated}
      title={t("chat.statusPanel.goal")}
      trailing={() => (control ? <>{control}</> : null)}
    >
      {/* One iteration row in ZCode's anatomy (numbered badge when completed,
          GoalIcon while live); our projection has no iteration history, so the
          live goal renders as the current round's row. */}
      <div
        data-goal-iteration={goal.rounds}
        data-goal-iteration-completed="false"
        className="status-goal-row"
        title={goal.objective}
      >
        <GoalIcon size={16} className="status-goal-icon" />
        <p className="status-goal-text">{goal.objective}</p>
        <span className="status-goal-counter">{goal.rounds}/{goal.maxRounds}</span>
      </div>
    </StatusSection>
  );
}

/* ── Todo section (C.4) ──────────────────────────────────────────────────── */

function PlanStatusIcon({ status }: { status: StatusPanelTodoItem["status"] }) {
  if (status === "completed") {
    return <CheckCircle2Icon size={14} className="status-todo-icon status-todo-icon-completed" />;
  }
  if (status === "inProgress") {
    return <ArrowRightIcon size={14} className="status-todo-icon status-todo-icon-running" />;
  }
  return <CircleIcon size={14} className="status-todo-icon status-todo-icon-pending" />;
}

function PlanStatusItemRows({ items }: { items: StatusPanelTodoItem[] }) {
  return items.map((item) => (
    <li key={item.id} data-plan-status={item.status} className={`status-todo-row${item.status === "completed" ? " is-completed" : ""}`}>
      <PlanStatusIcon status={item.status} />
      <span className="status-todo-text" title={item.content}>{item.content}</span>
    </li>
  ));
}

/** Fold-row preview (C.4): Radix HoverCard's openDelay 120 / closeDelay 80 as
 * explicit timers; `(hover: none)` touch opens on tap instead. */
const TODO_PREVIEW_OPEN_DELAY_MS = 120;
const TODO_PREVIEW_CLOSE_DELAY_MS = 80;

function TodoHiddenGroupPreview({
  group,
  items,
  open,
  onOpenChange,
}: {
  group: "preceding" | "following";
  items: StatusPanelTodoItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const scheduleOpen = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    if (open || openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      onOpenChange(true);
    }, TODO_PREVIEW_OPEN_DELAY_MS);
  };
  const scheduleClose = () => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (!open || closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      onOpenChange(false);
    }, TODO_PREVIEW_CLOSE_DELAY_MS);
  };

  const messageId =
    group === "preceding"
      ? items.every((item) => item.status === "completed")
        ? "chat.statusPanel.todoCompletedFold"
        : "chat.statusPanel.todoEarlierFold"
      : items.every((item) => item.status === "pending")
        ? "chat.statusPanel.todoWaitingFold"
        : "chat.statusPanel.todoLaterFold";
  const label = t(messageId, { count: items.length });

  return (
    <div className={`status-todo-preview${open ? " is-open" : ""}`} data-status-todo-preview={group}>
      <button
        type="button"
        aria-expanded={open}
        data-status-todo-preview-trigger={group}
        className="status-todo-fold"
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={scheduleOpen}
        onBlur={scheduleClose}
        onClick={(event) => {
          // HoverCard behavior: desktop click must not close what hover opened;
          // only touch input (hover: none) opens on tap.
          if (
            !event.defaultPrevented &&
            typeof window !== "undefined" &&
            typeof window.matchMedia === "function" &&
            window.matchMedia("(hover: none)").matches
          ) {
            onOpenChange(true);
          }
        }}
      >
        <ChevronLeftIcon size={14} />
        <span className="status-todo-fold-label">{label}</span>
      </button>
      {open ? (
        <div className="status-todo-preview-content" data-status-todo-preview-content={group} role="tooltip">
          <div className="status-todo-preview-inner">
            <p className="status-todo-preview-heading">{label}</p>
            <ul className="status-todo-preview-list">
              <PlanStatusItemRows items={items} />
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PlanStatusItems({ items }: { items: StatusPanelTodoItem[] }) {
  const [openPreviewGroup, setOpenPreviewGroup] = useState<"preceding" | "following" | null>(null);
  const window = getStatusPanelTodoFocusWindow(items);
  return (
    <ul className="status-todo-list">
      {window.compact && window.precedingItems.length > 0 ? (
        <li>
          <TodoHiddenGroupPreview
            group="preceding"
            items={window.precedingItems}
            open={openPreviewGroup === "preceding"}
            onOpenChange={(open) => setOpenPreviewGroup((current) => (open ? "preceding" : current === "preceding" ? null : current))}
          />
        </li>
      ) : null}
      <PlanStatusItemRows items={window.focusItems} />
      {window.compact && window.followingItems.length > 0 ? (
        <li>
          <TodoHiddenGroupPreview
            group="following"
            items={window.followingItems}
            open={openPreviewGroup === "following"}
            onOpenChange={(open) => setOpenPreviewGroup((current) => (open ? "following" : current === "following" ? null : current))}
          />
        </li>
      ) : null}
    </ul>
  );
}

function PlanStatusSection({
  plan,
  separated,
}: {
  plan: NonNullable<StatusPanelModel["plan"]>;
  separated: boolean;
}) {
  const { t } = useI18n();
  const isCompleted = plan.totalCount > 0 && plan.completedCount >= plan.totalCount;
  return (
    <StatusSection
      section="plan"
      separated={separated}
      title={t("chat.statusPanel.todo")}
      trailing={() => (
        <span className={`status-todo-counter${isCompleted ? " is-completed" : ""}`}>
          {plan.completedCount}/{plan.totalCount}
        </span>
      )}
    >
      {/* Remount on content change like ZCode's joined-item key: the focus
          window recomputes against the new snapshot, not the old one's state. */}
      <PlanStatusItems
        key={plan.items.map((item) => `${item.id}\u0000${item.content}\u0000${item.status}`).join("\u0001")}
        items={plan.items}
      />
    </StatusSection>
  );
}

/* ── Terminal + Agent work sections (A.3/B.4) ────────────────────────────── */

/** The row's transparent overlay sibling: a row cannot BE a button once it
 * also carries a Stop button, so an absolute inset-0 z-0 button carries
 * "open detail", the content rides pointer-events-none z-1. Verbatim trick,
 * minus the Stop itself — our runtime exposes no job cancel RPC, and ZCode's
 * own button renders null without a handler. */
function WorkRow({
  icon,
  title,
  elapsedLabel,
  ariaLabel,
  testId,
  onOpen,
  overlayClassName,
}: {
  icon: ReactNode;
  title: string;
  elapsedLabel: string;
  ariaLabel: string;
  testId: string;
  onOpen?: () => void;
  overlayClassName?: string;
}) {
  return (
    <li className="status-work-row" data-work-title={title}>
      {onOpen ? (
        <button
          type="button"
          className={`status-work-overlay${overlayClassName ? ` ${overlayClassName}` : ""}`}
          aria-label={ariaLabel}
          data-testid={testId}
          onClick={onOpen}
        />
      ) : null}
      <span className="status-work-icon">{icon}</span>
      <div className="status-work-body">
        <p className="status-work-title">{title}</p>
        <div className="status-work-meta">
          <span className="status-work-elapsed">{elapsedLabel}</span>
        </div>
      </div>
    </li>
  );
}

function BackgroundWorkStatusSection({
  now,
  onOpenBackgroundBash,
  onOpenChange,
  open,
  separated,
  works,
}: {
  now: number;
  onOpenBackgroundBash?: (work: StatusPanelWork) => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  separated: boolean;
  works: StatusPanelWork[];
}) {
  const { t } = useI18n();
  const orderedRunningWorks = useMemo(
    () => [...works].sort((left, right) => left.startedAt - right.startedAt),
    [works],
  );
  if (works.length === 0) return null;
  const longestElapsedMs = orderedRunningWorks.reduce(
    (longest, work) => Math.max(longest, Math.max(0, now - work.startedAt)),
    0,
  );
  return (
    <StatusSection
      section="terminal"
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={t("chat.statusPanel.terminals")}
      trailing={(isOpen) =>
        isOpen ? (
          <span>{t(works.length === 1 ? "chat.statusPanel.runningStatusValue" : "chat.statusPanel.runningStatusValuePlural", { count: works.length })}</span>
        ) : (
          <>
            <span className="status-trailing-elapsed">{formatDurationUnits(Math.max(1, Math.floor(longestElapsedMs / 1000)), t)}</span>
            <span className="status-trailing-separator">·</span>
            <span className="status-trailing-count">{t(works.length === 1 ? "chat.summaryPanel.runningBackgroundTasksMiniValue" : "chat.summaryPanel.runningBackgroundTasksMiniValuePlural", { count: works.length })}</span>
          </>
        )
      }
    >
      <ul className="status-work-list">
        {orderedRunningWorks.map((work) => (
          <WorkRow
            key={work.workId}
            icon={<SquareTerminalIcon size={16} />}
            title={work.title}
            elapsedLabel={formatBackgroundTaskElapsedLabel(Math.max(0, now - work.startedAt), t)}
            ariaLabel={t("chat.bashOutput.open", { title: work.title })}
            testId="background-bash-open"
            onOpen={onOpenBackgroundBash ? () => onOpenBackgroundBash(work) : undefined}
          />
        ))}
      </ul>
    </StatusSection>
  );
}

function SubagentStatusSection({
  now,
  onOpenChange,
  onOpenSubagentSession,
  open,
  parentSessionId,
  separated,
  subagents,
}: {
  now: number;
  onOpenChange?: (open: boolean) => void;
  onOpenSubagentSession?: (subagent: StatusPanelSubagent) => void;
  open?: boolean;
  parentSessionId?: string;
  separated: boolean;
  subagents: StatusPanelSubagent[];
}) {
  const { t } = useI18n();
  const ordered = useMemo(
    () => [...subagents].sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0)),
    [subagents],
  );
  if (subagents.length === 0) return null;
  const longestElapsedMs = ordered.reduce(
    (longest, item) => Math.max(longest, Math.max(0, now - (item.startedAt ?? now))),
    0,
  );
  return (
    <StatusSection
      section="agent"
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={t("chat.statusPanel.agents")}
      trailing={(isOpen) =>
        isOpen ? (
          <span>{t(subagents.length === 1 ? "chat.statusPanel.runningAgentsValue" : "chat.statusPanel.runningAgentsValuePlural", { count: subagents.length })}</span>
        ) : (
          <>
            <span className="status-trailing-elapsed">{formatDurationUnits(Math.max(1, Math.floor(longestElapsedMs / 1000)), t)}</span>
            <span className="status-trailing-separator">·</span>
            <span className="status-trailing-count">{t(subagents.length === 1 ? "chat.statusPanel.runningAgentsValue" : "chat.statusPanel.runningAgentsValuePlural", { count: subagents.length })}</span>
          </>
        )
      }
    >
      <ul className="status-work-list">
        {ordered.map((subagent) => {
          // buildRunningSubagentOpenRequest: no parent session, no openable tab.
          const canOpen = Boolean(parentSessionId && onOpenSubagentSession);
          return (
            <WorkRow
              key={subagent.childSessionId}
              icon={<BotIcon size={16} />}
              title={subagent.title}
              elapsedLabel={formatBackgroundTaskElapsedLabel(Math.max(0, now - (subagent.startedAt ?? now)), t)}
              ariaLabel={t("chat.summaryPanel.openRunningSubagentSession")}
              testId="background-subagent-open"
              overlayClassName="status-work-overlay-agent"
              onOpen={canOpen ? () => onOpenSubagentSession?.(subagent) : undefined}
            />
          );
        })}
      </ul>
    </StatusSection>
  );
}

/* ── Mini pill (C.6) ────────────────────────────────────────────────────── */

function StatusSummaryMetric({ children, icon }: { children: ReactNode; icon: ReactNode }) {
  return (
    <div className="status-summary-metric">
      <span className="status-summary-icon">
        <span className="status-summary-icon-front">{icon}</span>
        <Maximize2Icon size={16} className="status-summary-icon-expand" />
      </span>
      {children}
    </div>
  );
}

function StatusSummaryRow({
  model,
  onVariantChange,
}: {
  model: StatusPanelModel;
  onVariantChange?: (variant: StatusPanelVariant | null) => void;
}) {
  const { t } = useI18n();
  const expandLabel = t("chat.summaryPanel.showPanel");
  const selection = getStatusPanelSummarySelection(model);

  if (!selection) return null;

  const summaryMetric =
    selection.kind === "currentTodo" ? (
      <StatusSummaryMetric icon={<ArrowRightIcon size={16} />}>
        <span className="status-summary-text">{selection.content}</span>
      </StatusSummaryMetric>
    ) : selection.kind === "activeGoal" ? (
      <StatusSummaryMetric icon={<GoalIcon size={16} />}>
        <span className="status-summary-text">{selection.title}</span>
      </StatusSummaryMetric>
    ) : selection.kind === "completedTodo" ? (
      <StatusSummaryMetric icon={<CheckCircle2Icon size={16} className="status-icon-success" />}>
        <span className="status-summary-text">{selection.content}</span>
      </StatusSummaryMetric>
    ) : selection.kind === "todoCounter" ? (
      <StatusSummaryMetric icon={<ListChecksIcon size={16} className="status-icon-subtle" />}>
        <span className="status-summary-text">{t("chat.statusPanel.todo")}</span>
        <span className="status-summary-counter">{selection.completedCount}/{selection.totalCount}</span>
      </StatusSummaryMetric>
    ) : (
      <StatusSummaryMetric
        icon={
          selection.bashCount > 0 && selection.subagentCount > 0 ? (
            <ActivityIcon size={16} />
          ) : selection.bashCount > 0 ? (
            <SquareTerminalIcon size={16} />
          ) : (
            <BotIcon size={16} />
          )
        }
      >
        {/* Product rule: the live count is the fallback only — the pill never
            repeats what the composer badge already counts. */}
        <span className="status-summary-count">
          {selection.subagentCount > 0
            ? t(selection.bashCount + selection.subagentCount === 1 ? "chat.statusPanel.runningAgentsValue" : "chat.statusPanel.runningAgentsValuePlural", { count: selection.bashCount + selection.subagentCount })
            : t("chat.summaryPanel.runningBackgroundTasksMiniValue", { count: selection.bashCount })}
        </span>
      </StatusSummaryMetric>
    );

  return (
    <button
      type="button"
      aria-label={expandLabel}
      title={expandLabel}
      className="status-pill-trigger"
      onClick={() => onVariantChange?.("panel")}
    >
      {summaryMetric}
    </button>
  );
}

/* ── The panel shell (C.2) ───────────────────────────────────────────────── */

export interface ConversationStatusPanelProps {
  goal: GoalStatusProjection | null;
  todoItems: StatusPanelTodoItem[];
  works: StatusPanelWork[];
  subagents: StatusPanelSubagent[];
  parentSessionId?: string;
  variantOverride: StatusPanelVariant | null;
  onVariantChange?: (variant: StatusPanelVariant | null) => void;
  terminalSectionOpen?: boolean;
  onTerminalSectionOpenChange?: (open: boolean) => void;
  agentSectionOpen?: boolean;
  onAgentSectionOpenChange?: (open: boolean) => void;
  onOpenBackgroundBash?: (work: StatusPanelWork) => void;
  onOpenSubagentSession?: (subagent: StatusPanelSubagent) => void;
  onGoalCommand?: (command: "/goal pause" | "/goal resume") => void;
}

export function ConversationStatusPanel({
  goal,
  todoItems,
  works,
  subagents,
  parentSessionId,
  variantOverride,
  onVariantChange,
  terminalSectionOpen,
  onTerminalSectionOpenChange,
  agentSectionOpen,
  onAgentSectionOpenChange,
  onOpenBackgroundBash,
  onOpenSubagentSession,
  onGoalCommand,
}: ConversationStatusPanelProps) {
  const { t } = useI18n();
  const model = useMemo(
    () => buildStatusPanelModel({ goal, todoItems, works, subagents }),
    [goal, todoItems, works, subagents],
  );
  const variant: StatusPanelVariant = variantOverride ?? "auto";
  const [menuOpen, setMenuOpen] = useState(false);
  // One shared 1s clock while any work rows tick.
  const now = useNowTicker(model.runningBashWorks.length > 0 || model.runningSubagents.length > 0);

  if (!model.hasContent) return null;

  const layoutMode = variant === "mini" || !model.hasContent ? "none" : variant === "panel" ? "inline" : "auto";
  const isMini = variant === "mini";
  const canRenderGoal = Boolean(model.goal);
  const canRenderPlan = Boolean(model.plan);
  const canRenderTerminals = model.runningBashWorks.length > 0;
  const canRenderAgents = model.runningSubagents.length > 0;

  return (
    <div className={`status-panel-host status-panel-host--${layoutMode}`}>
      <aside
        aria-label={t("chat.summaryPanel.title")}
        data-testid="chat-summary-panel"
        data-state={isMini ? "collapsed" : "expanded"}
        data-display-mode={variant}
        data-goal-status={model.goal?.status}
        data-goal-objective={model.goal?.objective}
        data-running-background-count={model.runningBashWorks.length + model.runningSubagents.length}
        data-running-terminal-count={model.runningBashWorks.length}
        data-running-agent-count={model.runningSubagents.length}
        className={`status-panel status-panel--${variant}`}
      >
        {!isMini ? (
          <div className={`status-panel-toolbar${variant === "auto" ? " status-panel-toolbar--auto" : ""}`}>
            <button
              type="button"
              className="status-icon-button"
              aria-label={t("chat.summaryPanel.displayMode")}
              title={t("chat.summaryPanel.displayMode")}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
              onBlur={() => setMenuOpen(false)}
            >
              <EllipsisIcon size={14} />
            </button>
            {menuOpen ? (
              <div className="status-panel-menu" role="menu">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={variant === "auto"}
                  className="status-panel-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onVariantChange?.(null);
                  }}
                >
                  <span className="status-panel-menu-dot" aria-hidden="true" />
                  {t("chat.summaryPanel.displayModeAuto")}
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="status-icon-button"
              aria-label={t("chat.summaryPanel.showMini")}
              title={t("chat.summaryPanel.showMini")}
              onClick={() => onVariantChange?.("mini")}
            >
              <Minimize2Icon size={14} />
            </button>
          </div>
        ) : null}
        {!isMini ? (
          <div className={`status-panel-body${variant === "auto" ? " status-panel-body--auto" : ""}`}>
            {canRenderGoal ? (
              <GoalStatusSection
                goal={model.goal!}
                onGoalCommand={onGoalCommand}
                separated={false}
              />
            ) : null}
            {canRenderPlan ? (
              <PlanStatusSection
                plan={model.plan!}
                separated={canRenderGoal}
              />
            ) : null}
            {canRenderTerminals ? (
              <BackgroundWorkStatusSection
                now={now}
                onOpenBackgroundBash={onOpenBackgroundBash}
                open={terminalSectionOpen}
                onOpenChange={onTerminalSectionOpenChange}
                separated={canRenderGoal || canRenderPlan}
                works={model.runningBashWorks}
              />
            ) : null}
            {canRenderAgents ? (
              <SubagentStatusSection
                now={now}
                open={agentSectionOpen}
                onOpenChange={onAgentSectionOpenChange}
                separated={canRenderGoal || canRenderPlan || canRenderTerminals}
                parentSessionId={parentSessionId}
                onOpenSubagentSession={onOpenSubagentSession}
                subagents={model.runningSubagents}
              />
            ) : null}
          </div>
        ) : null}
        <div
          aria-hidden={!isMini}
          className={`status-pill${isMini ? " status-pill--mini" : variant === "panel" ? " status-pill--hidden" : " status-pill--auto"}`}
        >
          <StatusSummaryRow model={model} onVariantChange={onVariantChange} />
        </div>
      </aside>
    </div>
  );
}
