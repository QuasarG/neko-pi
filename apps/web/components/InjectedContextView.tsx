import { producerOf, producerSummaries, type InjectedContextParts } from "@earendil-works/pi-coding-agent/injected-context";
import { MarkdownBody } from "./MarkdownBody";

export function InjectedContextView({ parts }: { parts: InjectedContextParts }) {
  const summaries = producerSummaries(parts);
  const producers = [...new Set(parts.blocks.map((block) => producerOf(block.tag)))];
  return (
    <div data-injected-context className="injected-context">
      {producers.map((producer) => (
        <details key={producer} className="injected-context-details">
          <summary className="injected-context-summary">
            <span className="injected-context-chevron" aria-hidden="true">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </span>
            Context · {producer}{summaries.find((row) => row.producer === producer)?.facts.map((fact) => ` · ${fact}`).join("")}
          </summary>
          <div className="injected-context-content">
            {parts.blocks.filter((block) => producerOf(block.tag) === producer).map((block, index) => (
              <section key={`${block.tag}-${index}`} className="injected-context-section">
                <strong>{block.tag}</strong>
                <MarkdownBody className="injected-context-markdown">{block.body}</MarkdownBody>
              </section>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
