"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageView } from "./MessageView";
import { buildToolResultsMap, EMPTY_TRANSCRIPT, groupViewerTurns, mergeTailPage, prependOlderPage, type SubagentTranscript } from "./subagent-viewer-state";
import { useI18n } from "@/hooks/useI18n";
import { ProcessDetailsGroup } from "./ProcessDetailsGroup";
import { createStreamingStore } from "@/lib/streaming-message";
import type { AgentEventLike, ClientAssistantMessageEvent } from "@/lib/agent-event-wire";
import type { AgentMessage, SessionInfo } from "@/lib/types";

interface Props {
  sessionId: string;
  /** Label from the subagent tool call (`description || profile`), used until the session info loads. */
  fallbackLabel: string;
  running: boolean;
  onOpenFile: (filePath: string, page?: number) => void;
  /** Nested subagents: a grandchild's row opens its OWN right-panel tab (user order 2026-10-31). */
  onOpenSubagent?: (sessionId: string, label: string) => void;
}

// R49 (user report: the child's panel "stuttered" at message granularity): the
// context endpoint serves committed entries, so the poll IS the stream. 800ms
// keeps a running child reading at close to the cadence entries commit, and
// each arriving page rides the message entrance fade, which reads as flowing.
const POLL_MS = 800;
const TAIL = 100;

function contextUrl(sessionId: string, before?: string): string {
  const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1", tail: String(TAIL) });
  if (before) params.set("before", before);
  return `/api/sessions/${encodeURIComponent(sessionId)}/context?${params}`;
}

function toTranscript(page: Partial<SubagentTranscript>): SubagentTranscript {
  return {
    messages: page.messages ?? [],
    entryIds: page.entryIds ?? [],
    oldestEntryId: page.oldestEntryId ?? null,
    hasMore: Boolean(page.hasMore),
  };
}

/**
 * Read-only view of a subagent's session, rendered in a right-panel tab.
 *
 * Live updates deliberately poll the context endpoint instead of opening the
 * agent SSE stream: `GET /api/sessions/[id]/context` serves the in-memory
 * entries of a running wrapper (or the file once it settles) without ever
 * spawning a wrapper, so a viewer tab can never resurrect or interfere with a
 * subagent run. Entry-level granularity: pi appends each finished entry
 * synchronously, so a 2 s poll shows the run at message/tool-call resolution.
 */
export function SubagentViewer({ sessionId, fallbackLabel, running, onOpenFile, onOpenSubagent }: Props) {
  const { t, locale } = useI18n();
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [label, setLabel] = useState(fallbackLabel);
  const [transcript, setTranscript] = useState<SubagentTranscript>(EMPTY_TRANSCRIPT);
  const { messages, entryIds, oldestEntryId, hasMore } = transcript;
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Session info on open and when the run starts or ends (the persisted status
  // takes over from the live flag): label, cwd.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (res.status === 404) return; // keep the fallback label; the context poll reports "starting"
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { info?: SessionInfo; error?: string };
        if (!data.info) throw new Error(data.error ?? `HTTP ${res.status}`);
        setInfo(data.info);
        setLabel(data.info.name || data.info.firstMessage || fallbackLabel);
      } catch {
        /* non-fatal: the context view below is the primary content */
      }
    })();
    return () => controller.abort();
  }, [sessionId, running, fallbackLabel]);

  // Initial context load; while the subagent runs, poll for new entries. Each
  // poll is the newest page, folded into the older pages already loaded.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      // One request at a time: a slow answer must not land after a newer one.
      if (inFlight) return;
      loadRef.current = load;
      inFlight = true;
      try {
        const res = await fetch(contextUrl(sessionId), { signal: controller.signal, cache: "no-store" });
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { context: Partial<SubagentTranscript> };
        if (cancelled) return;
        setNotFound(false);
        setError(null);
        setTranscript((current) => mergeTailPage(current, toTranscript(data.context)));
      } catch (err) {
        if (!cancelled && !(err instanceof Error && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        inFlight = false;
      }
    };
    void load();
    if (!running) {
      return () => {
        cancelled = true;
        controller.abort();
      };
    }
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [sessionId, running]);

  // R50 (user order): the viewer streams like the main panel does — one SSE
  // connection to the child's own event stream while it runs. Deltas build the
  // in-flight message live (the same streaming assembler the chat uses); every
  // completed entry triggers an immediate canonical read, so the poll below is
  // only the safety net, not the stream.
  const liveStore = useMemo(() => createStreamingStore(), [sessionId]);
  const [liveMessage, setLiveMessage] = useState<AgentMessage | null>(null);
  useEffect(() => liveStore.subscribe(() => {
    const state = liveStore.getState();
    setLiveMessage(state.isStreaming ? state.streamingMessage : null);
  }), [liveStore]);
  useEffect(() => {
    if (!running) return;
    const source = new EventSource(`/api/agent/${encodeURIComponent(sessionId)}/events?holder=viewer-${sessionId.slice(0, 8)}`);
    let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
    const reconcile = () => {
      if (reconcileTimer !== null) return;
      reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        void loadRef.current?.();
      }, 120);
    };
    source.onmessage = (event) => {
      let parsed: AgentEventLike;
      try {
        parsed = JSON.parse(event.data) as AgentEventLike;
      } catch {
        return;
      }
      if (parsed.type === "agent_start") liveStore.dispatch({ type: "start" });
      else if (parsed.type === "message_update" && parsed.assistantMessageEvent) {
        liveStore.dispatch({ type: "delta", event: parsed.assistantMessageEvent as ClientAssistantMessageEvent });
      } else if (parsed.type === "message_end") {
        liveStore.dispatch({ type: "end" });
        reconcile();
      } else if (parsed.type === "agent_end" || parsed.type === "prompt_done") {
        reconcile();
      }
    };
    source.onerror = () => {
      // The stream closes when the child settles; the poll keeps the tail true.
    };
    return () => {
      source.close();
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
      liveStore.dispatch({ type: "end" });
    };
  }, [sessionId, running, liveStore]);

  const loadRef = useRef<(() => Promise<void>) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  // Distance from the bottom to keep while an older page is prepended.
  const prependAnchorRef = useRef<number | null>(null);
  const loadingEarlierRef = useRef(false);
  const pagingControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => pagingControllerRef.current?.abort(), []);

  // Page upward through older entries, like the main chat's history paging.
  const loadEarlier = useCallback(async () => {
    const cursor = oldestEntryId;
    if (!cursor || loadingEarlierRef.current) return;
    loadingEarlierRef.current = true;
    const controller = new AbortController();
    pagingControllerRef.current = controller;
    setLoadingEarlier(true);
    try {
      const res = await fetch(contextUrl(sessionId, cursor), { signal: controller.signal, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { context: Partial<SubagentTranscript> };
      // A poll replaced the transcript meanwhile: this page no longer joins on.
      if (transcriptRef.current.oldestEntryId !== cursor) return;
      const el = listRef.current;
      prependAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
      setTranscript((current) => prependOlderPage(current, cursor, toTranscript(data.context)));
    } catch {
      /* paging is best-effort; the button stays for a retry */
    } finally {
      loadingEarlierRef.current = false;
      if (pagingControllerRef.current === controller) pagingControllerRef.current = null;
      if (!controller.signal.aborted) setLoadingEarlier(false);
    }
  }, [oldestEntryId, sessionId]);

  // Stick to the bottom while new entries arrive, unless the user scrolled up;
  // a prepended older page leaves what the user was reading in place.
  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);
  useLayoutEffect(() => {
    const el = listRef.current;
    const anchor = prependAnchorRef.current;
    prependAnchorRef.current = null;
    if (!el) return;
    if (anchor !== null) el.scrollTop = el.scrollHeight - anchor;
    else if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const toolResults = useMemo(() => buildToolResultsMap(messages), [messages]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minWidth: 0 }}>
      {/* ZCode's subagent pane (catalog B.1/B.2) mounts the conversation itself
          read-only — no bespoke header: the tab title carries the label and the
          transcript's own rows carry the state. The old 36px inline-styled
          header (bot svg + label + status + refresh) is gone. */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        /* R46: the same conversation scope the main column renders under —
           without it the ink ladder and message rhythm fall back to global
           defaults, so tool rows read brighter and looser than the chat. */
        className="chat-content"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "10px 0" }}
        lang={locale}
        aria-label={label}
      >
        {notFound ? (
          <div style={{ padding: "24px 16px", color: "var(--text-muted)", fontSize: "var(--font-size-sm)", textAlign: "center" }}>
            {running ? t("subagent.viewer.starting") : t("subagent.viewer.error")}
          </div>
        ) : error && messages.length === 0 ? (
          <div role="alert" style={{ padding: "24px 16px", color: "#dc2626", fontSize: "var(--font-size-sm)", textAlign: "center" }}>
            {t("subagent.viewer.error")}
            <div style={{ marginTop: 6, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{error}</div>
          </div>
        ) : (
          <>
            {hasMore && (
              <div style={{ display: "flex", justifyContent: "center", padding: "4px 0 10px" }}>
                <button
                  type="button"
                  onClick={loadEarlier}
                  disabled={loadingEarlier}
                  style={{
                    fontSize: "var(--font-size-sm)", padding: "4px 12px", borderRadius: 6,
                    border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)",
                    cursor: loadingEarlier ? "default" : "pointer",
                  }}
                >
                  {t("i18n.loadMore")}
                </button>
              </div>
            )}
            {groupViewerTurns(messages).map((turn) => {
              if (turn.kind === "raw") {
                const index = turn.index;
                return (
                  <div key={entryIds[index] ?? index} className="subagent-viewer-entry" style={{ padding: "2px 12px" }}>
                    <MessageView
                      message={messages[index]}
                      toolResults={toolResults}
                      cwd={info?.cwd}
                      onOpenFile={onOpenFile}
                      onOpenSubagent={onOpenSubagent}
                      sessionId={sessionId}
                      entryId={entryIds[index]}
                    />
                  </div>
                );
              }
              // R47 (user order): a child's transcript folds its turns the way
              // the main conversation does — the work under the band, the final
              // reply under it. The container rides the entrance fade so each
              // poll's arrivals read as streaming (R49).
              return (
                <div key={`turn-${entryIds[turn.anchor] ?? turn.anchor}`} className="subagent-viewer-entry" style={{ padding: "2px 12px" }}>
                  <MessageView
                    message={messages[turn.anchor]}
                    toolResults={toolResults}
                    cwd={info?.cwd}
                    onOpenFile={onOpenFile}
                    onOpenSubagent={onOpenSubagent}
                    sessionId={sessionId}
                    entryId={entryIds[turn.anchor]}
                  />
                  {turn.process.length > 0 && (
                    <ProcessDetailsGroup
                      messageCount={turn.process.length}
                      toolCallCount={turn.process.reduce(
                        (count, message) => count + ((message as { content?: Array<{ type?: string }> }).content ?? [])
                          .filter((block) => block?.type === "toolCall").length,
                        0,
                      )}
                      t={t}
                    >
                      {turn.process.map((message, offset) => {
                        const index = turn.anchor + 1 + offset;
                        return (
                          <MessageView
                            key={entryIds[index] ?? index}
                            message={message}
                            toolResults={toolResults}
                            cwd={info?.cwd}
                            onOpenFile={onOpenFile}
                            onOpenSubagent={onOpenSubagent}
                            sessionId={sessionId}
                            entryId={entryIds[index]}
                            showTimestamp={false}
                            showActions={false}
                          />
                        );
                      })}
                    </ProcessDetailsGroup>
                  )}
                  {turn.answer !== undefined && (
                    <MessageView
                      message={messages[turn.answer]}
                      toolResults={toolResults}
                      cwd={info?.cwd}
                      onOpenFile={onOpenFile}
                      onOpenSubagent={onOpenSubagent}
                      sessionId={sessionId}
                      entryId={entryIds[turn.answer]}
                      showActions={false}
                    />
                  )}
                </div>
              );
            })}
            {/* R50: the in-flight reply, streamed token by token over the
                child's own event stream — same look as the main panel. */}
            {liveMessage && (
              <div className="subagent-viewer-entry" style={{ padding: "2px 12px" }}>
                <MessageView
                  message={liveMessage}
                  isStreaming
                  toolResults={toolResults}
                  cwd={info?.cwd}
                  onOpenFile={onOpenFile}
                  onOpenSubagent={onOpenSubagent}
                  sessionId={sessionId}
                />
              </div>
            )}
            {messages.length === 0 && !error && !liveMessage && (
              <div style={{ padding: "24px 16px", color: "var(--text-dim)", fontSize: "var(--font-size-sm)", textAlign: "center" }}>
                {t("subagent.viewer.empty")}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
