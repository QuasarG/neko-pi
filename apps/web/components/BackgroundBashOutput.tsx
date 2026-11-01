"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ArrowDownIcon, LoaderCircleIcon } from "./tool-icons";

/* ZCode's BackgroundBashOutputSidePane (catalog A.4), ported as anatomy over
 * our poll route: RAW TEXT output (a pre.whitespace-pre-wrap mono block, NOT
 * markdown — copied honestly), a statusbar with the running spinner and the
 * full-file link, a 1s poll while the job runs, and frozen-snapshot follow
 * semantics (scrolling up freezes what you were reading; reaching the bottom
 * or the floating arrow resumes). */

export interface BackgroundBashOutputSnapshot {
  status: "running" | "completed" | "failed";
  output: string;
  outputFile: string | null;
}

/** Pure follow decision (A.4's onScroll): scrolling up while not at the
 * bottom freezes; landing at the bottom thaws. The 8px threshold is applied
 * by the caller when it computes `atBottom`. */
export function nextBashFollowAction(
  following: boolean,
  atBottom: boolean,
  scrolledUp: boolean,
): "pause" | "resume" | null {
  if (following && scrolledUp && !atBottom) return "pause";
  if (!following && atBottom) return "resume";
  return null;
}

/** The poll hook (useBackgroundBashOutput.ts): fetch on mount and every 1000ms
 * while the job runs, one in-flight guard, hidden tabs stop polling, and a
 * frozen snapshot kept while the reader scrolled away from the tail. */
export function useBackgroundBashOutput(
  sessionId: string,
  jobId: string,
  visible: boolean,
): {
  latest: BackgroundBashOutputSnapshot | null;
  display: BackgroundBashOutputSnapshot | null;
  error: string | null;
  following: boolean;
  refresh: () => void;
  pause: () => void;
  resume: () => void;
} {
  const [latest, setLatest] = useState<BackgroundBashOutputSnapshot | null>(null);
  const [frozen, setFrozen] = useState<BackgroundBashOutputSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(false);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    setLatest(null);
    setFrozen(null);
    setError(null);
  }, [sessionId, jobId]);

  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/background-jobs?jobId=${encodeURIComponent(jobId)}`,
          { cache: "no-store" },
        );
        if (disposed) return;
        if (res.status === 404) {
          setError("notFound");
          return;
        }
        if (!res.ok) {
          setError("queryFailed");
          return;
        }
        const data = await res.json() as {
          success?: boolean;
          data?: { status: BackgroundBashOutputSnapshot["status"]; output: string; outputFile: string | null };
        };
        if (disposed || !data.success || !data.data) return;
        setLatest({
          status: data.data.status,
          output: data.data.output,
          outputFile: data.data.outputFile,
        });
        setError(null);
        if (data.data.status === "running") timer = setTimeout(() => void poll(), 1000);
      } catch {
        if (!disposed) setError("queryFailed");
      } finally {
        inFlight.current = false;
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, jobId, visible, revision]);

  return {
    latest,
    display: frozen ?? latest,
    error,
    following: frozen === null,
    refresh,
    pause: () => setFrozen((current) => current ?? latest),
    resume: () => {
      setFrozen(null);
      refresh();
    },
  };
}

export function BackgroundBashOutput({
  sessionId,
  jobId,
  title,
  visible,
}: {
  sessionId: string;
  jobId: string;
  title: string;
  /** Only the active tab polls; a hidden tab keeps its last snapshot. */
  visible: boolean;
}) {
  const { t } = useI18n();
  const preview = useBackgroundBashOutput(sessionId, jobId, visible);
  const { latest, display, following } = preview;
  const scroll = useRef<HTMLDivElement>(null);
  const previousTop = useRef(0);
  useLayoutEffect(() => {
    if (!visible || !following || !scroll.current) return;
    scroll.current.scrollTop = scroll.current.scrollHeight;
    previousTop.current = scroll.current.scrollTop;
  }, [visible, following, display?.output]);

  return (
    <section
      data-testid="background-bash-details"
      data-work-id={jobId}
      data-status={latest?.status ?? "loading"}
      data-following={following}
      className="background-bash-details"
    >
      {preview.error ? (
        <div role="alert" className="background-bash-error">
          <span>{t(`chat.bashOutput.error.${preview.error}`)}</span>
          <button type="button" className="background-bash-retry" onClick={preview.refresh}>
            {t("chat.bashOutput.retry")}
          </button>
        </div>
      ) : null}
      <div data-testid="background-bash-statusbar" className="background-bash-statusbar">
        {latest?.status === "running" ? (
          <span role="status" data-testid="background-bash-running" className="background-bash-running">
            <LoaderCircleIcon size={12} className="is-spinning" />
            {t("chat.bashOutput.status.running")}
          </span>
        ) : null}
        {latest?.outputFile ? (
          <a
            className="background-bash-file"
            data-testid="background-bash-file"
            href={`/api/sessions/${encodeURIComponent(sessionId)}/background-jobs?jobId=${encodeURIComponent(jobId)}&download=1`}
            title={latest.outputFile}
            download
          >
            {t("chat.bashOutput.fullFile")}
          </a>
        ) : null}
      </div>
      <div className="background-bash-scrollwrap">
        <div
          ref={scroll}
          data-testid="background-bash-scroll"
          className="background-bash-scroll"
          tabIndex={0}
          title={title}
          onScroll={(event) => {
            if (!visible) return;
            const el = event.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
            const scrolledUp = el.scrollTop < previousTop.current;
            const action = nextBashFollowAction(following, atBottom, scrolledUp);
            if (action === "pause") preview.pause();
            else if (action === "resume") preview.resume();
            previousTop.current = el.scrollTop;
          }}
        >
          <pre data-testid="background-bash-output" className="background-bash-output">
            {display?.output || (display ? t("chat.bashOutput.empty") : "")}
          </pre>
        </div>
        {!following ? (
          <button
            type="button"
            className="background-bash-resume"
            data-testid="background-bash-resume"
            aria-label={t("chat.scrollToBottom")}
            title={t("chat.scrollToBottom")}
            onClick={preview.resume}
          >
            <ArrowDownIcon size={16} />
          </button>
        ) : null}
      </div>
    </section>
  );
}
