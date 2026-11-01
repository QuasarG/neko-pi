"use client";

import type { InjectedContextParts } from "@earendil-works/pi-coding-agent/injected-context";
import { MarkdownBody } from "./MarkdownBody";

/**
 * The right-panel view of a user message's injected context (user order
 * 2026-10-31): every block as a tagged section through the same markdown
 * chain the conversation uses.
 */
export function InjectedContextDetail({ parts }: { parts: InjectedContextParts }) {
  return (
    <div className="injected-context-detail">
      {parts.blocks.map((block, index) => (
        <section key={`${block.tag}-${index}`} className="injected-context-detail-section">
          <strong className="injected-context-detail-tag">{block.tag}</strong>
          <MarkdownBody className="injected-context-detail-markdown">{block.body}</MarkdownBody>
        </section>
      ))}
    </div>
  );
}
