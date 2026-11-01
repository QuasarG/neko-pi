"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { openStackedDialog } from "@/lib/stacked-dialog";

export interface BugReportDialogModel {
  provider: string;
  modelId: string;
}

/** The consent the dialog collects, as the TUI's promptForOptions does. */
export interface BugReportChoices {
  hint: string;
  includeSession: boolean;
  includeSummary: boolean;
  delivery: "upload" | "zip";
}

export type BugReportStep = "hint" | "transcript" | "summary" | "delivery";

/** The step that follows the current one; `null` when `from` is the last. */
export function bugReportNextStep(from: BugReportStep, includeSession: boolean): BugReportStep | null {
  switch (from) {
    case "hint": return "transcript";
    case "transcript": return includeSession ? "delivery" : "summary";
    case "summary": return "delivery";
    default: return null;
  }
}

/** The label for "written by …"/"sent to …": the model's id, or a generic. */
export function bugReportModelLabel(model: BugReportDialogModel | null): string {
  return model?.modelId || "";
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
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

function fileNameFromDisposition(disposition: string | null, fallback: string): string {
  const plain = disposition ? /filename="?([^";]+)"?/i.exec(disposition)?.[1] : undefined;
  return plain?.trim() || fallback;
}

/**
 * The /bug consent flow, mirroring the TUI's sequence with the same wording
 * intent: disclaimer and hint, transcript include (with what the transcript
 * holds), the model-written summary offered only when the transcript was
 * declined (with the "sent to your own provider" warning), and a delivery
 * recap naming the actual gateway host. Choices are POSTed as-is; the server
 * appends the same pi.bug-report entry the TUI does.
 */
export function BugReportDialog({
  sessionId,
  initialHint,
  model,
  onClose,
}: {
  sessionId: string;
  initialHint: string;
  model: BugReportDialogModel | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<BugReportStep>("hint");
  const [hint, setHint] = useState(initialHint);
  const [includeSession, setIncludeSession] = useState<boolean | null>(null);
  const [includeSummary, setIncludeSummary] = useState(false);
  const [info, setInfo] = useState<{ gatewayHost: string; offline: boolean } | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"upload" | "zip" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  const doneRef = useRef(done);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    busyRef.current = busy;
    doneRef.current = done;
    onCloseRef.current = onClose;
  }, [busy, done, onClose]);

  useEffect(() => openStackedDialog(document, dialogRef.current, () => {
    if (!busyRef.current && !doneRef.current) onCloseRef.current();
  }), []);

  useEffect(() => {
    let active = true;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/bug-report`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { gatewayHost?: string; offline?: boolean; error?: string };
        if (!active) return;
        if (response.ok && typeof data.gatewayHost === "string") {
          setInfo({ gatewayHost: data.gatewayHost, offline: data.offline === true });
        } else {
          setInfoError(data.error ?? `HTTP ${response.status}`);
        }
      })
      .catch((reason: unknown) => {
        if (active) setInfoError(errorMessage(reason));
      });
    return () => { active = false; };
  }, [sessionId]);

  const modelLabel = bugReportModelLabel(model);
  const withModel = (key: string) => t(key, { model: modelLabel || t("bug.theCurrentModel") });

  const deliver = async (delivery: "upload" | "zip") => {
    setError(null);
    setBusy(delivery);
    setStep("delivery");
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/bug-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hint: hint.trim(), includeSession: includeSession === true, includeSummary, delivery }),
      });
      if (delivery === "zip") {
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        const fileName = fileNameFromDisposition(response.headers.get("content-disposition"), "pi-bug-report.zip");
        triggerDownload(await response.blob(), fileName);
        setDone(t("bug.successZip", { file: fileName }));
        return;
      }
      const data = await response.json().catch(() => ({})) as { reportId?: string; error?: string };
      if (!response.ok || !data.reportId) throw new Error(data.error ?? `HTTP ${response.status}`);
      setDone(t("bug.successUpload", { id: data.reportId }));
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const back = () => {
    setError(null);
    if (step === "transcript") setStep("hint");
    else if (step === "summary") setStep("transcript");
    else if (step === "delivery") setStep(includeSession ? "transcript" : "summary");
  };

  const footer = (children: React.ReactNode) => (
    <div className="project-trust-footer">
      {busy ? null : (
        <button type="button" className="project-trust-button" onClick={step === "hint" ? onClose : back}>
          {step === "hint" ? t("bug.cancel") : t("bug.back")}
        </button>
      )}
      {children}
    </div>
  );

  return (
    <div
      role="presentation"
      className="project-trust-backdrop"
      onClick={(event) => {
        if (!busy && !done && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bug-dialog-title"
        tabIndex={-1}
        className="project-trust-dialog"
      >
        <div className="project-trust-body">
          <div className="project-trust-content">
            <div id="bug-dialog-title" className="project-trust-title">{t("bug.title")}</div>

            {step === "hint" && (
              <>
                <div className="project-trust-text">{t("bug.disclaimer")}</div>
                <label className="project-trust-text" style={{ display: "block", marginTop: 12 }} htmlFor="bug-hint">
                  {t("bug.hintLabel")}
                </label>
                <textarea
                  id="bug-hint"
                  value={hint}
                  onChange={(event) => setHint(event.target.value)}
                  rows={3}
                  style={{
                    width: "100%",
                    marginTop: 6,
                    padding: "6px 8px",
                    borderRadius: 5,
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: "var(--text)",
                    font: "inherit",
                    resize: "vertical",
                  }}
                />
              </>
            )}

            {step === "transcript" && (
              <>
                <div className="project-trust-title" style={{ fontSize: "var(--font-size-caption)" }}>{t("bug.transcriptTitle")}</div>
                <div className="project-trust-text">{t("bug.transcriptNote")}</div>
              </>
            )}

            {step === "summary" && (
              <>
                <div className="project-trust-title" style={{ fontSize: "var(--font-size-caption)" }}>{withModel("bug.summaryTitle")}</div>
                <div className="project-trust-text">
                  {t("bug.summaryNote", { provider: model?.provider || t("bug.theCurrentProvider") })}
                </div>
              </>
            )}

            {step === "delivery" && (
              <>
                <div className="project-trust-title" style={{ fontSize: "var(--font-size-caption)" }}>{t("bug.deliveryTitle")}</div>
                <div className="project-trust-text">
                  {hint.trim() ? t("bug.recapHint", { hint: hint.trim() }) : t("bug.recapHintEmpty")}
                  <br />
                  {t("bug.recapTranscript", {
                    value: t(includeSession ? "bug.recapTranscriptIncluded" : "bug.recapTranscriptExcluded"),
                  })}
                  <br />
                  {t("bug.recapSummary", {
                    value: includeSummary
                      ? t("bug.recapSummaryModel", { model: modelLabel || t("bug.theCurrentModel") })
                      : t("bug.recapSummaryNone"),
                  })}
                </div>
                <div className="project-trust-text">
                  {info
                    ? t("bug.recapDelivery", { host: info.gatewayHost })
                    : infoError ?? "…"}
                </div>
                {info?.offline && <p role="alert" className="project-trust-notice">{t("bug.offline")}</p>}
                {busy && (
                  <p role="status" className="project-trust-notice">
                    {includeSummary && !done
                      ? withModel("bug.busySummary")
                      : t(busy === "upload" ? "bug.busyUpload" : "bug.busyBuild")}
                  </p>
                )}
                {done && <p role="status" className="project-trust-notice">{done}</p>}
              </>
            )}
          </div>
        </div>
        {error && <div role="alert" className="project-trust-error">{error}</div>}

        {done ? (
          <div className="project-trust-footer">
            <button type="button" className="project-trust-button" onClick={onClose}>{t("bug.close")}</button>
          </div>
        ) : step === "hint" ? (
          footer(
            <button
              type="button"
              className="project-trust-button is-primary"
              onClick={() => setStep("transcript")}
            >
              {t("bug.continue")}
            </button>,
          )
        ) : step === "transcript" ? (
          footer(<>
            <button
              type="button"
              className="project-trust-button"
              onClick={() => { setIncludeSession(false); setStep("summary"); }}
            >
              {t("bug.optionNo")}
            </button>
            <button
              type="button"
              className="project-trust-button is-primary"
              onClick={() => { setIncludeSession(true); setIncludeSummary(false); setStep("delivery"); }}
            >
              {t("bug.transcriptYes")}
            </button>
          </>)
        ) : step === "summary" ? (
          footer(<>
            <button
              type="button"
              className="project-trust-button"
              onClick={() => { setIncludeSummary(false); setStep("delivery"); }}
            >
              {t("bug.optionNo")}
            </button>
            <button
              type="button"
              className="project-trust-button is-primary"
              onClick={() => { setIncludeSummary(true); setStep("delivery"); }}
            >
              {t("bug.summaryYes")}
            </button>
          </>)
        ) : (
          footer(<>
            <button
              type="button"
              className="project-trust-button"
              disabled={busy !== null || info?.offline === true}
              onClick={() => void deliver("upload")}
            >
              {t("bug.upload")}
            </button>
            <button
              type="button"
              className="project-trust-button is-primary"
              disabled={busy !== null}
              aria-busy={busy !== null || undefined}
              onClick={() => void deliver("zip")}
            >
              {t("bug.zip")}
            </button>
          </>)
        )}
      </div>
    </div>
  );
}
