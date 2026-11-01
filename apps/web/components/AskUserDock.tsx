"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { askUserSubmitPayload, toggleAskUserOption, type AskUserQuestionView } from "@/lib/ask-user-view";
import type { ExtensionUiRequest } from "@/lib/types";

type SelectRequest = Extract<ExtensionUiRequest, { method: "select" }>;

export function AskUserDock({ request, question, waitingCount, onRespond }: {
  request: SelectRequest;
  question: AskUserQuestionView;
  waitingCount: number;
  onRespond: (request: SelectRequest, response: { value: string } | { values: string[] } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  // Single-select holds at most one label; multi-select accumulates. Toggling
  // only changes this state — nothing is sent until Submit (Q02 semantics).
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!request.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);
  const remaining = request.expiresAt ? Math.max(0, Math.ceil((request.expiresAt - now) / 1000)) : null;
  const payload = askUserSubmitPayload(question, selected, freeText);
  const freeTextAnswer = freeText.trim().length > 0;
  return (
    <section className="ask-user-dock" aria-label={request.title}>
      <div className="ask-user-heading">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.5 8.5a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 16h.01" /></svg>
        <span className="ask-user-mode">{t(question.background ? "chat.questionBackground" : "chat.questionWaiting")}</span>
        {question.header && <span className="ask-user-header-label">{question.header}</span>}
        <span className="ask-user-meta">{waitingCount > 0 && t("chat.extensionMoreWaiting", { count: waitingCount })}{remaining !== null && ` · ${remaining}s`}</span>
        <button type="button" className="chat-icon-action" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={t(collapsed ? "chat.extensionExpand" : "chat.extensionCollapse")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ transform: collapsed ? "rotate(180deg)" : undefined }} aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
        </button>
      </div>
      {!collapsed && <form onSubmit={(event) => {
        event.preventDefault();
        // Nothing picked and no free text: Submit is disabled, and a synthetic
        // submit (Enter) must not send an empty answer either.
        if (!payload) return;
        onRespond(request, payload);
      }}>
        <p className="ask-user-question">{question.question}</p>
        <div className="ask-user-options">
          {question.options.map((option, index) => {
            const isSelected = !freeTextAnswer && selected.includes(option.label);
            return (
              <label key={option.label} className={`ask-user-option${isSelected ? " is-selected" : ""}`}>
                <input
                  type={question.multiSelect ? "checkbox" : "radio"}
                  name={`ask-${request.id}`}
                  value={option.label}
                  checked={isSelected}
                  onChange={() => { setSelected(toggleAskUserOption(question.multiSelect, selected, option.label)); setFreeText(""); }}
                />
                <span className="ask-user-option-number" aria-hidden="true">{index + 1}</span>
                <span><span className="ask-user-option-label">{option.label}</span>{option.description && <span className="ask-user-option-description">{option.description}</span>}</span>
              </label>
            );
          })}
        </div>
        <textarea rows={1} value={freeText} onChange={(event) => setFreeText(event.target.value)} placeholder={t("chat.questionOther")} aria-label={t("chat.questionOther")} />
        <div className="ask-user-footer">
          <span>{t(question.background ? "chat.questionBackgroundHint" : "chat.questionWaitingHint")}</span>
          <button type="button" className="chat-action-secondary" onClick={() => onRespond(request, { cancelled: true })}>{t("chat.questionSkip")}</button>
          <button type="submit" className="chat-action-primary" disabled={!payload || remaining === 0}>{t("chat.submit")}</button>
        </div>
      </form>}
    </section>
  );
}
