"use client";

import { useEffect, useState } from "react";

/** How long a collapsing disclosure keeps its content mounted, in ms. The
 * grid-rows transition folds over --motion-base (160ms); this window clears
 * it with a small buffer, as ZCode's collapsible does with its 300ms. */
export const DISCLOSE_UNMOUNT_DELAY_MS = 200;

/**
 * Whether a collapsible's content should still be mounted. Opening renders
 * immediately (same commit); closing keeps the previous content one delay
 * window longer so the CSS collapse animation finishes before the unmount —
 * without it the content vanishes and the fold flashes blank.
 *
 * The first render matches `open`, so server rendering and history restores
 * never mount closed content (or drop open content) early.
 */
export function useDelayedUnmount(open: boolean, delayMs: number = DISCLOSE_UNMOUNT_DELAY_MS): boolean {
  const [rendered, setRendered] = useState(open);
  const [previousOpen, setPreviousOpen] = useState(open);

  // Adjust during render (the pattern ThinkingBlock already uses): an open
  // flip must not wait a commit, or the expanding wrapper would mount a frame
  // late and skip its entrance.
  if (previousOpen !== open) {
    setPreviousOpen(open);
    if (open) setRendered(true);
  }

  useEffect(() => {
    if (rendered && !open) {
      const timer = window.setTimeout(() => setRendered(false), delayMs);
      return () => window.clearTimeout(timer);
    }
  }, [rendered, open, delayMs]);

  return rendered;
}
