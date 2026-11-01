"use client";

import { useEffect, useState } from "react";
import type { AgentMessage } from "@/lib/types";
import type { StatusPanelSubagent, StatusPanelTodoItem, StatusPanelWork } from "@/components/conversation-status-panel";
import type { SessionInfo } from "@/lib/types";

/* Wave N data adapters (catalog DATA ADAPTER NOTES): our payloads → the
 * status-panel model's inputs. Pure pieces live here so tests can pin the
 * mapping without a DOM. */

export interface BackgroundJobClientEntry {
  id: string;
  kind: "bash" | "subagent";
  label: string;
  startedAt: number;
  status: "running" | "completed" | "failed";
  exitCode?: number | null;
  outputFile?: string;
}

/** Registry rows → panel works: only RUNNING bash jobs become rows (the card's
 * own product rule — finished bash jobs have no residual UI). */
export function backgroundJobsToWorks(jobs: BackgroundJobClientEntry[]): StatusPanelWork[] {
  return jobs
    .filter((job) => job.status === "running" && job.kind === "bash")
    .map((job) => ({ workId: job.id, kind: job.kind, title: job.label, startedAt: job.startedAt }));
}

/** The session family's running subagents → agent rows: title from the
 * relation description (or profile), startedAt from the session's modified
 * time (coarse — the catalog accepts this). */
export function runningSubagentRows(
  subagents: SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
): StatusPanelSubagent[] {
  return subagents
    .filter((session) => runningSessionIds.has(session.id))
    .map((session) => ({
      childSessionId: session.id,
      title: session.relation?.kind === "subagent"
        ? (session.relation.description || session.relation.profile)
        : (session.name || session.firstMessage),
      startedAt: Date.parse(session.modified) || null,
    }));
}

/** The latest todo_write block's items, in snapshot order — ZCode's `plan`
 * projection, read from our transcript. The most recent call wins entirely
 * (a todo_write is a full-list replace). */
export function latestTodoWriteItems(messages: AgentMessage[]): StatusPanelTodoItem[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    for (const block of message.content ?? []) {
      if (block.type !== "toolCall" || block.toolName !== "todo_write") continue;
      const raw = block.input?.items;
      if (!Array.isArray(raw)) return [];
      return raw.flatMap((item: unknown, itemIndex: number) => {
        if (!item || typeof item !== "object" || !("content" in item) || typeof (item as { content: unknown }).content !== "string") return [];
        const status = "status" in item && typeof (item as { status: unknown }).status === "string"
          ? (item as { status: string }).status
          : "pending";
        return [{
          id: `${block.toolCallId}:${itemIndex}`,
          content: (item as { content: string }).content,
          status: status === "in_progress" ? "inProgress" as const
            : status === "completed" ? "completed" as const
            : "pending" as const,
        }];
      });
    }
  }
  return [];
}

/** Poll the background-jobs route: once on mount / session change / wake-key
 * change (the extension's `background` status line moving), then every second
 * while anything runs or the session is busy — a job can only start inside a
 * turn, so an idle session with no jobs needs no timer. */
export function useSessionBackgroundJobs(
  sessionId: string | null,
  options: { sessionBusy: boolean; wakeKey: string },
): BackgroundJobClientEntry[] {
  const { sessionBusy, wakeKey } = options;
  const [jobs, setJobs] = useState<BackgroundJobClientEntry[]>([]);
  const anyRunning = jobs.some((job) => job.status === "running");

  useEffect(() => {
    setJobs([]);
    if (!sessionId) return;
    let disposed = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/background-jobs`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json() as { success?: boolean; data?: { jobs?: BackgroundJobClientEntry[] } };
        if (!disposed && data.success && data.data?.jobs) setJobs(data.data.jobs);
      } catch {
        /* best-effort: the badge keeps its last counts */
      }
    };
    void load();
    if (!sessionBusy && !anyRunning) return () => { disposed = true; };
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void load();
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
    // anyRunning restarting the interval when it flips is harmless (still 1s);
    // it is what stops the timer once the last job finishes.
  }, [sessionId, sessionBusy, wakeKey, anyRunning]);

  return jobs;
}
