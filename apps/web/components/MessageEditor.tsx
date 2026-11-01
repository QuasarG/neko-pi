"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

export function MessageEditor({ text, onCancel, onSubmit }: {
  text: string;
  onCancel: () => void;
  onSubmit: (text: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(text);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(320, textarea.scrollHeight)}px`;
  }, [value]);
  const submit = async () => {
    if (submitting || !value.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit(value);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form className="message-editor" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <textarea
        ref={textareaRef}
        aria-label={t("i18n.editFromHere")}
        value={value}
        disabled={submitting}
        rows={2}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && !submitting) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="message-editor-actions">
        <button type="button" className="chat-action-secondary" onClick={onCancel} disabled={submitting}>{t("chat.cancel")}</button>
        <button type="submit" className="chat-action-primary" disabled={submitting || !value.trim()}>{t("chat.send")}</button>
      </div>
    </form>
  );
}
