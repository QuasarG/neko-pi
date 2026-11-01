"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { openStackedDialog } from "@/lib/stacked-dialog";

/** What GET /api/sessions/[id]/share answers: the persisted destination. */
export interface ShareDialogInfo {
  destination: "auto" | "radius" | "gist";
  gatewayHost: string;
}

export type ShareDialogInfoState =
  | { state: "loading" }
  | { state: "failed"; error: string }
  | { state: "loaded"; info: ShareDialogInfo };

/** Parse the GET answer; exported for tests. */
export function shareDialogInfoFrom(ok: boolean, status: number, data: Partial<{ destination?: unknown; gatewayHost?: unknown; error?: string }>): ShareDialogInfoState {
  const destination = data.destination;
  const gatewayHost = data.gatewayHost;
  if (ok && (destination === "auto" || destination === "radius" || destination === "gist") && typeof gatewayHost === "string") {
    return { state: "loaded", info: { destination, gatewayHost } };
  }
  return { state: "failed", error: (typeof data.error === "string" && data.error) || `HTTP ${status}` };
}

/** The i18n key naming where the upload would go; exported for tests. */
export function shareDestinationTextKey(destination: ShareDialogInfo["destination"]): string {
  return `share.destination.${destination}`;
}

/** The download's file name, from the response's Content-Disposition; exported for tests. */
export function attachmentFileName(disposition: string | null, fallback: string): string {
  const starred = disposition ? /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition)?.[1] : undefined;
  if (starred) {
    try {
      return decodeURIComponent(starred.trim().replace(/^"|"$/g, ""));
    } catch {
      // Fall through to the plain filename.
    }
  }
  const plain = disposition ? /filename="?([^";]+)"?/i.exec(disposition)?.[1] : undefined;
  return plain?.trim() || fallback;
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * The /share consent dialog: it states exactly what leaves the machine — the
 * whole current session branch as JSONL plus the system prompt and tool
 * schemas — shows the persisted destination the TUI's /share uses, and offers
 * the no-network "download the same JSONL" escape hatch before any upload.
 */
export function ShareDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<ShareDialogInfoState>({ state: "loading" });
  const [busy, setBusy] = useState<"share" | "download" | null>(null);
  const [result, setResult] = useState<{ url: string; gistUrl?: string } | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Read through refs, so the Escape listener registered once sees the current values.
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  const resultRef = useRef(result);
  useEffect(() => {
    busyRef.current = busy;
    onCloseRef.current = onClose;
    resultRef.current = result;
  }, [busy, onClose, result]);

  useEffect(() => openStackedDialog(document, dialogRef.current, () => {
    if (!busyRef.current && !resultRef.current) onCloseRef.current();
  }), []);

  useEffect(() => {
    let active = true;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/share`, { cache: "no-store" })
      .then(async (response) => shareDialogInfoFrom(response.ok, response.status, await response.json().catch(() => ({}))))
      .then((next) => { if (active) setInfo(next); })
      .catch((reason: unknown) => {
        if (active) setInfo({ state: "failed", error: reason instanceof Error ? reason.message : String(reason) });
      });
    return () => { active = false; };
  }, [sessionId]);

  const post = async (delivery: "upload" | "download") => {
    setError(null);
    setBusy(delivery === "upload" ? "share" : "download");
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delivery }),
      });
      if (delivery === "download") {
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        triggerDownload(
          await response.blob(),
          attachmentFileName(response.headers.get("content-disposition"), `session-${sessionId}.jsonl`),
        );
        setDownloaded(true);
        return;
      }
      const data = await response.json().catch(() => ({})) as { url?: string; gistUrl?: string; error?: string };
      if (!response.ok || !data.url) throw new Error(data.error ?? `HTTP ${response.status}`);
      setResult({ url: data.url, ...(data.gistUrl ? { gistUrl: data.gistUrl } : {}) });
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      role="presentation"
      className="project-trust-backdrop"
      onClick={(event) => {
        if (!busy && !result && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        tabIndex={-1}
        className="project-trust-dialog"
      >
        <div className="project-trust-body">
          <div className="project-trust-content">
            <div id="share-dialog-title" className="project-trust-title">{t("share.title")}</div>
            <div className="project-trust-text">{t("share.whatLeaves")}</div>
            <div className="project-trust-title" style={{ marginTop: 14, fontSize: "var(--font-size-caption)" }}>{t("share.destination")}</div>
            <div className="project-trust-text" data-share-destination={info.state === "loaded" ? info.info.destination : undefined}>
              {info.state === "loading" && "…"}
              {info.state === "failed" && t("share.loadFailed")}
              {info.state === "loaded" && (info.info.destination === "radius"
                ? t(shareDestinationTextKey(info.info.destination), { host: info.info.gatewayHost })
                : t(shareDestinationTextKey(info.info.destination)))}
            </div>
            <div className="project-trust-text" style={{ color: "var(--text-muted)", marginTop: 10 }}>{t("share.downloadHint")}</div>
            {downloaded && <p role="status" className="project-trust-notice">{t("share.downloadDone")}</p>}
          </div>
        </div>
        {error && (
          <div role="alert" className="project-trust-error">
            {error}
          </div>
        )}
        {result ? (
          <>
            <div className="project-trust-body" style={{ paddingTop: 0 }}>
              <div className="project-trust-content">
                <div className="project-trust-text">
                  {t("share.success")}{" "}
                  <a href={result.url} target="_blank" rel="noopener noreferrer" style={{ overflowWrap: "anywhere" }}>{result.url}</a>
                </div>
                {result.gistUrl && (
                  <div className="project-trust-text">
                    {t("share.gistNote")}{" "}
                    <a href={result.gistUrl} target="_blank" rel="noopener noreferrer" style={{ overflowWrap: "anywhere" }}>{result.gistUrl}</a>
                  </div>
                )}
              </div>
            </div>
            <div className="project-trust-footer">
              <button type="button" className="project-trust-button" onClick={onClose}>{t("share.close")}</button>
            </div>
          </>
        ) : (
          <div className="project-trust-footer">
            <button
              type="button"
              className="project-trust-button"
              disabled={busy !== null}
              onClick={() => void post("download")}
            >
              {t("share.download")}
            </button>
            <button type="button" className="project-trust-button" disabled={busy !== null} onClick={onClose}>
              {t("share.cancel")}
            </button>
            <button
              type="button"
              className="project-trust-button is-primary"
              disabled={busy !== null || info.state !== "loaded"}
              aria-busy={busy === "share" || undefined}
              onClick={() => void post("upload")}
            >
              {busy === "share" ? t("share.busy") : t("share.share")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
