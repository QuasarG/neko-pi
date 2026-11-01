"use client";

import {
  producerOf,
  producerSummaries,
  type InjectedContextParts,
} from "@earendil-works/pi-coding-agent/injected-context";
import { BookOpenTextIcon, BrainIcon, ClockIcon, type IconComponent } from "./tool-icons";

/**
 * Injected context as per-producer chips in the user row's hover actions
 * (user order 2026-10-31): each injected kind gets its own button — shown
 * only when that message actually carries it — and the detail opens in the
 * right panel, never inline.
 */
const PRODUCER_ICON: Partial<Record<string, IconComponent>> = {
  "runtime-context": ClockIcon,
  memory: BrainIcon,
};

export function InjectedContextChips({ parts, keySeed, onOpen }: {
  parts: InjectedContextParts;
  /** entryId (or message timestamp) — keeps tab keys unique per message. */
  keySeed: string;
  onOpen: (payload: { key: string; title: string; parts: InjectedContextParts }) => void;
}) {
  const summaries = producerSummaries(parts);
  const producers = [...new Set(parts.blocks.map((block) => producerOf(block.tag)))];
  if (producers.length === 0) return null;
  return (
    <>
      {producers.map((producer) => {
        const Icon = PRODUCER_ICON[producer] ?? BookOpenTextIcon;
        const facts = summaries.find((row) => row.producer === producer)?.facts ?? [];
        const line = [producer, ...facts].join(" · ");
        return (
          <button
            key={producer}
            type="button"
            className="injected-context-chip"
            data-producer={producer}
            title={line}
            aria-label={line}
            onClick={(event) => {
              event.stopPropagation();
              onOpen({
                key: `${keySeed}:${producer}`,
                title: producer,
                parts: {
                  userText: parts.userText,
                  blocks: parts.blocks.filter((block) => producerOf(block.tag) === producer),
                },
              });
            }}
          >
            <Icon size={14} />
            <span>{producer}</span>
          </button>
        );
      })}
    </>
  );
}
