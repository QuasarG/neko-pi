"use client";

import { useEffect, useState } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { focusModalPanel, listenForPanelEscape } from "@/lib/stacked-dialog";

export function CommandHelpDialog({ kind, onClose }: { kind: "changelog" | "hotkeys"; onClose: () => void }) {
  const [markdown, setMarkdown] = useState<string | null>(kind === "hotkeys" ? "" : null);
  const title = kind === "changelog" ? "What's New" : "Keyboard shortcuts";

  useEffect(() => {
    if (kind !== "changelog") return;
    const controller = new AbortController();
    fetch("/api/changelog", { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { markdown?: string; error?: string };
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        setMarkdown(data.markdown ?? "No changelog entries found.");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMarkdown(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [kind]);

  useEffect(() => listenForPanelEscape(document, onClose), [onClose]);
  useEffect(() => focusModalPanel(document, document.querySelector<HTMLElement>("[data-command-help-dialog]")), []);

  return (
    <div className="settings-dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} data-command-help-dialog className="settings-dialog-surface" style={{ width: "min(760px, calc(100vw - 32px))", maxHeight: "min(80vh, 900px)", display: "flex", flexDirection: "column" }}>
        <header className="settings-dialog-header">
          <strong className="settings-dialog-title">{title}</strong>
          <button type="button" onClick={onClose} aria-label="Close" className="settings-dialog-close">×</button>
        </header>
        <div style={{ overflow: "auto", padding: 20 }}>
          {kind === "hotkeys" ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--font-size-caption)" }}>
              <tbody>
                <tr><th style={cellStyle}>Ctrl+Alt+N</th><td style={cellStyle}>Start a new session</td></tr>
                <tr><th style={cellStyle}>Escape</th><td style={cellStyle}>Stop the current run or close the active panel</td></tr>
                <tr><th style={cellStyle}>Enter</th><td style={cellStyle}>Send the composer message</td></tr>
                <tr><th style={cellStyle}>Shift+Enter</th><td style={cellStyle}>Insert a new line</td></tr>
                <tr><th style={cellStyle}>↑ / ↓</th><td style={cellStyle}>Move through slash commands and suggestions</td></tr>
              </tbody>
            </table>
          ) : markdown === null ? (
            <p role="status" style={{ color: "var(--text-muted)" }}>Loading…</p>
          ) : (
            <MarkdownBody>{markdown}</MarkdownBody>
          )}
        </div>
      </section>
    </div>
  );
}

const cellStyle = { padding: "9px 10px", borderBottom: "1px solid var(--border)", textAlign: "left" as const };
