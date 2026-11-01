"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * ZCode's QueuedSummaryContent (§2.3/§5), ported without motion/react: when a
 * tool row's summary text CHANGES (a discrete new value, not a streaming
 * append), the old line rolls up out of flow while the new rolls in from
 * below — y ±0.8em with opacity over 300ms cubic-bezier(0.4, 0, 0.2, 1), held
 * 500ms between rolls. A change while a roll plays is queued (at most 2
 * pending; same-key updates land in place, streaming-appends never re-roll),
 * and a timer drift over 250ms flushes the queue to its newest entry so a
 * busy main thread never replays stale summaries. Reduced motion lands every
 * value in place; CSS conversation.css carries the matching keyframe cutoff.
 *
 * The whole lifecycle is a pure reducer (below) so the admission rules and
 * the entrance flag are testable without a DOM; the component only wires
 * timers and renders the reducer's state.
 */

export const SUMMARY_ROLL_TRANSITION_MS = 300;
export const SUMMARY_ROLL_HOLD_MS = 500;
export const SUMMARY_ROLL_TOTAL_MS = SUMMARY_ROLL_TRANSITION_MS + SUMMARY_ROLL_HOLD_MS;
const SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS = 250;
const SUMMARY_ROLL_MAX_PENDING = 2;

/** A late timer flushes a long queue to its newest entry (ZCode's drift skip). */
export function resolveQueuedSummaryPlaybackQueue<T>(queued: readonly T[], timerDriftMs: number): T[] {
  if (timerDriftMs > SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS && queued.length > 1) {
    return queued.slice(-1);
  }
  return [...queued];
}

/**
 * Queue admission (ZCode's enqueue): a snapshot already waiting updates its
 * own slot in place; otherwise the newcomer takes the cut-in slot while the
 * first queued entry is never replaced, and the queue caps at 2 pending —
 * three slots total: what shows, what plays next, one cut-in.
 */
export function admitQueuedSummary(
  queue: readonly SummaryRollSnapshot[],
  snapshot: SummaryRollSnapshot,
): SummaryRollSnapshot[] {
  const existingIndex = queue.findIndex((item) => item.key === snapshot.key);
  if (existingIndex >= 0) {
    const next = [...queue];
    next[existingIndex] = snapshot;
    return next;
  }
  if (queue.length === 0) return [snapshot];
  return [queue[0]!, snapshot].slice(0, SUMMARY_ROLL_MAX_PENDING);
}

export interface SummaryRollSnapshot {
  key: string;
  text: ReactNode;
}

/** What shows, what is rolling out, what waits, and the entrance flag. */
export interface QueuedSummaryRollState {
  displayed: SummaryRollSnapshot;
  exiting: SummaryRollSnapshot | null;
  queued: SummaryRollSnapshot[];
  /** True while a roll's hold window still runs (the timer is live). */
  rolling: boolean;
  /** The displayed item arrived by a roll and enters with data-roll="in". */
  rolledIn: boolean;
}

export type QueuedSummaryRollEvent =
  | { type: "content"; snapshot: SummaryRollSnapshot; animate: boolean }
  | { type: "timer"; timerDriftMs: number }
  | { type: "exit-done" };

export function initialQueuedSummaryRollState(snapshot: SummaryRollSnapshot): QueuedSummaryRollState {
  // ZCode's AnimatePresence initial={false}: the first value never rolls in.
  return { displayed: snapshot, exiting: null, queued: [], rolling: false, rolledIn: false };
}

function promote(state: QueuedSummaryRollState, snapshot: SummaryRollSnapshot): QueuedSummaryRollState {
  return {
    displayed: snapshot,
    exiting: state.displayed.key === snapshot.key ? state.exiting : state.displayed,
    queued: state.queued,
    rolling: true,
    rolledIn: true,
  };
}

/** The roll lifecycle's whole decision table. */
export function reduceQueuedSummaryRoll(
  state: QueuedSummaryRollState,
  event: QueuedSummaryRollEvent,
): QueuedSummaryRollState {
  if (event.type === "exit-done") {
    return state.exiting === null ? state : { ...state, exiting: null };
  }

  if (event.type === "timer") {
    if (!state.rolling) return state;
    // A timer that fired late skips the backlog: replaying stale summaries
    // after a stall reads as more stutter, not more motion.
    const playback = resolveQueuedSummaryPlaybackQueue(state.queued, event.timerDriftMs);
    const [head, ...rest] = playback;
    if (!head) return { ...state, rolling: false, queued: [] };
    return promote({ ...state, rolling: false, queued: rest }, head);
  }

  const { snapshot, animate } = event;
  if (!animate) {
    // Animation off (collapsed→expanded, reduced motion): land in place, and
    // drop any backlog so re-enabling never replays it.
    return { displayed: snapshot, exiting: null, queued: [], rolling: false, rolledIn: false };
  }

  if (state.displayed.key === snapshot.key) {
    // Same logical value (a streaming append): refresh in place, never roll.
    return { ...state, displayed: snapshot };
  }

  if (state.rolling || state.queued.length > 0) {
    return { ...state, queued: admitQueuedSummary(state.queued, snapshot) };
  }

  return promote(state, snapshot);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** True while a roll's hold window still runs — the component arms one clock
 *  per roll (300ms of motion + the 500ms hold) off these two state bits. */
function rollClockKey(state: QueuedSummaryRollState): string | null {
  return state.rolling ? state.displayed.key : null;
}

/** The media query both this component and the CSS keyframes honor. */
export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(query.matches);
    update();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    query.addListener(update);
    return () => query.removeListener(update);
  }, []);
  return prefersReducedMotion;
}

export function QueuedSummaryText({ contentKey, text, enabled = true, className }: {
  /** Identity of the logical value: rolls only when this changes. */
  contentKey: string;
  /** The displayed content; a same-key change refreshes in place. */
  text: ReactNode;
  /** Rolls play only while enabled (the row is collapsed, ZCode's animateContent && !isExpanded). */
  enabled?: boolean;
  className?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const animate = enabled && !reducedMotion;
  const [state, setState] = useState<QueuedSummaryRollState>(() =>
    initialQueuedSummaryRollState({ key: contentKey, text }),
  );

  // Incoming content flows through the reducer only — no side effects here.
  useEffect(() => {
    setState((current) => reduceQueuedSummaryRoll(current, {
      type: "content",
      snapshot: { key: contentKey, text },
      animate,
    }));
  }, [contentKey, text, animate]);

  // The roll clock: one pair of timers per roll. A queued roll taking over
  // changes displayed.key while rolling stays true, re-arming for the next
  // roll; a reset (animation off, nothing queued) drops the timers.
  const clockKey = rollClockKey(state);
  useEffect(() => {
    if (clockKey === null) return;
    const expectedTimerAt = now() + SUMMARY_ROLL_TOTAL_MS;
    const rollTimer = window.setTimeout(() => {
      setState((current) => reduceQueuedSummaryRoll(current, { type: "timer", timerDriftMs: now() - expectedTimerAt }));
    }, SUMMARY_ROLL_TOTAL_MS);
    // The out-animation is done when its 300ms elapse; the node can go.
    const exitTimer = window.setTimeout(() => {
      setState((current) => reduceQueuedSummaryRoll(current, { type: "exit-done" }));
    }, SUMMARY_ROLL_TRANSITION_MS);
    return () => {
      window.clearTimeout(rollTimer);
      window.clearTimeout(exitTimer);
    };
  }, [clockKey]);

  if (text == null || text === "") return null;

  return (
    <span className={["tool-summary-roll", className].filter(Boolean).join(" ")}>
      {state.exiting !== null && state.exiting.key !== state.displayed.key
        ? <span key={state.exiting.key} className="tool-summary-roll-item" data-roll="out">{state.exiting.text}</span>
        : null}
      <span key={state.displayed.key} className="tool-summary-roll-item" data-roll={state.rolledIn ? "in" : undefined}>{state.displayed.text}</span>
    </span>
  );
}
