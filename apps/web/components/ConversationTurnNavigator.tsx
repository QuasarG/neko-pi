"use client";

import { Fragment, memo, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";

/**
 * ZCode's ConversationTurnNavigator (v4/ConversationTurnNavigator.tsx), ported
 * to token CSS: the dash rail in the conversation's LEFT gutter, one bar per
 * USER query (no assistant/tool items), the wave scale on item hover
 * (conversationTurnNavigatorHelpers.ts:488-513, values verbatim), a hover card
 * previewing the query text, and click-to-scroll.
 *
 * Per the 2026-10-31 order the rail is HIDDEN by default and reveals when the
 * pointer enters the left gutter: the reveal listens for pointer moves on the
 * conversation layout itself (no overlay element, so nothing intercepts clicks
 * on the conversation); keyboard focus reveals it through :focus-within.
 */

export interface ConversationTurnNavigatorItem {
  /** Stable per-query key (the message key ChatWindow renders with). */
  key: string;
  /** The user entry's id in the session file; missing while a run is live. */
  entryId?: string;
  /** The query's own text (hover card + a11y). */
  text: string;
  /** The turn's final summary reply, clipped (hover card's second block). */
  assistantPreview?: string;
}

interface Props {
  items: ConversationTurnNavigatorItem[];
  /** The .conversation-layout host: the gutter zone measures against it. */
  layoutRef: RefObject<HTMLDivElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onJumpToQuery: (item: ConversationTurnNavigatorItem, behavior: ScrollBehavior) => void;
}

/** The left gutter's width that reveals the rail (ZCode's w-14 hover zone). */
const GUTTER_REVEAL_PX = 56;
/** Grace before hiding when the pointer leaves the gutter/rail (no flicker). */
const HIDE_GRACE_MS = 120;
/** Hover card timings (ZCode HoverCard openDelay/closeDelay). */
const CARD_OPEN_DELAY_MS = 120;
const CARD_CLOSE_DELAY_MS = 80;
/** A query counts as reached once its top passes this far into the viewport. */
const ACTIVE_LINE_OFFSET_PX = 120;

export type TurnNavigatorBarTone = "idle" | "mid" | "near" | "peak";

export interface TurnNavigatorBarVisualState {
  colorTone: "focus" | "muted";
  opacity: number;
  scaleX: number;
  tone: TurnNavigatorBarTone;
}

/**
 * The wave: resolveConversationTurnNavigatorBarVisualState verbatim
 * (conversationTurnNavigatorHelpers.ts:488-507). `distance` is the item's
 * distance from the focused item; undefined = nobody is interacting.
 */
export function turnNavigatorBarVisualState(distance: number | undefined): TurnNavigatorBarVisualState {
  if (distance === undefined) {
    return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
  }
  if (distance === 0) {
    return { colorTone: "focus", opacity: 1, scaleX: 2.6, tone: "peak" };
  }
  if (distance === 1) {
    return { colorTone: "muted", opacity: 0.86, scaleX: 1.7, tone: "near" };
  }
  if (distance === 2) {
    return { colorTone: "muted", opacity: 0.72, scaleX: 1.25, tone: "mid" };
  }
  return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
}

/**
 * The item the rail marks active: the last query whose top edge sits above the
 * viewport's top + 120px, in DOM order. `roots` pairs rendered query elements
 * with their item index (the rendered window is a suffix of the item list, so
 * unrendered older items take no part in the geometry).
 */
export function resolveActiveTurnNavigatorIndex(
  roots: ReadonlyArray<{ itemIndex: number; offsetTop: number }>,
  scrollTop: number,
): number {
  let active = -1;
  for (const root of roots) {
    if (root.offsetTop <= scrollTop + ACTIVE_LINE_OFFSET_PX) active = root.itemIndex;
    else break;
  }
  if (active === -1 && roots.length > 0) active = roots[0]!.itemIndex;
  return active;
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return prefersReducedMotion;
}

export const ConversationTurnNavigator = memo(function ConversationTurnNavigator({
  items,
  layoutRef,
  scrollContainerRef,
  onJumpToQuery,
}: Props) {
  const { t } = useI18n();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [revealed, setRevealed] = useState(false);
  const [interactionIndex, setInteractionIndex] = useState<number | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [card, setCard] = useState<{ index: number; top: number; left: number } | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverIndexRef = useRef<number | undefined>(undefined);
  const scrollFrameRef = useRef<number | null>(null);

  // ── Gutter reveal ─────────────────────────────────────────────────────
  // Pointer moves over the layout (bubbled from anywhere in the conversation)
  // reveal the rail inside the left 56px; leaving the zone starts the grace
  // timer. Focus inside the nav keeps it open (checked before hiding).
  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current !== null) return;
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      if (navRef.current?.contains(document.activeElement)) return;
      setRevealed(false);
    }, HIDE_GRACE_MS);
  }, []);
  const cancelHide = useCallback(() => {
    if (hideTimerRef.current === null) return;
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const onPointerMove = (event: PointerEvent) => {
      const rect = layout.getBoundingClientRect();
      if (event.clientX - rect.left <= GUTTER_REVEAL_PX) {
        cancelHide();
        setRevealed(true);
      } else {
        scheduleHide();
      }
    };
    const onPointerLeave = () => scheduleHide();
    layout.addEventListener("pointermove", onPointerMove);
    layout.addEventListener("pointerleave", onPointerLeave);
    return () => {
      layout.removeEventListener("pointermove", onPointerMove);
      layout.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [cancelHide, layoutRef, scheduleHide]);

  useEffect(() => () => {
    if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
    if (openTimerRef.current !== null) clearTimeout(openTimerRef.current);
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  // ── Scroll sync (passive listener, rAF-throttled) ─────────────────────
  useEffect(() => {
    if (items.length < 2) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const measure = () => {
      scrollFrameRef.current = null;
      const roots: Array<{ itemIndex: number; offsetTop: number }> = [];
      const containerTop = container.getBoundingClientRect().top;
      const elements = container.querySelectorAll<HTMLElement>('[data-message-role="user"]');
      // The rendered window is a suffix: the i-th element from the end maps to
      // the (items.length - 1 - i) item when every later user message is also
      // an item (empty-text user messages break the mapping; they are rare and
      // only cost a wrong active mark, not a wrong jump — entry ids anchor).
      for (let i = 0; i < elements.length; i += 1) {
        const element = elements[elements.length - 1 - i]!;
        const itemIndex = items.length - 1 - i;
        if (itemIndex < 0) break;
        const offsetTop = element.getBoundingClientRect().top - containerTop + container.scrollTop;
        roots.push({ itemIndex, offsetTop });
      }
      roots.reverse();
      setActiveIndex(resolveActiveTurnNavigatorIndex(roots, container.scrollTop));
    };

    const onScroll = () => {
      if (scrollFrameRef.current !== null) return;
      scrollFrameRef.current = requestAnimationFrame(measure);
    };
    measure();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [items, scrollContainerRef]);

  // Keep the active item visible inside the rail (ZCode scrollToIndex "auto").
  useEffect(() => {
    if (activeIndex < 0) return;
    const rail = railRef.current;
    const item = rail?.querySelector<HTMLElement>(`[data-item-index="${activeIndex}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // ── Hover card (openDelay 120ms / closeDelay 80ms, portal) ────────────
  const closeCard = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) return;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setCard(null);
    }, CARD_CLOSE_DELAY_MS);
  }, []);
  const openCard = useCallback((index: number) => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
    }
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      const rail = railRef.current;
      const item = rail?.querySelector<HTMLElement>(`[data-item-index="${index}"]`);
      if (!rail || !item || hoverIndexRef.current !== index) return;
      const itemRect = item.getBoundingClientRect();
      // Side right (align start), offset 8px, clamped so the 320px card stays
      // in the viewport.
      const cardHeight = cardRef.current?.offsetHeight ?? 80;
      const top = Math.max(8, Math.min(itemRect.top, window.innerHeight - cardHeight - 8));
      setCard({ index, top: Math.round(top), left: Math.round(itemRect.right + 8) });
    }, CARD_OPEN_DELAY_MS);
  }, []);

  if (items.length < 2) return null;

  const cardItem = card !== null ? items[card.index] : undefined;
  const cardText = cardItem?.text ?? "";
  const cardPreview = cardItem?.assistantPreview ?? "";

  return (
    <Fragment>
      <nav
        ref={navRef}
        aria-label={t("chat.turnNavigator.label")}
        className="conversation-turn-navigator"
        data-revealed={revealed || undefined}
        data-interacting={interactionIndex !== undefined || undefined}
      >
        <div
          ref={railRef}
          className="conversation-turn-navigator-rail"
          onPointerEnter={cancelHide}
          onPointerLeave={() => {
            scheduleHide();
            closeCard();
          }}
          onScroll={() => setInteractionIndex(undefined)}
        >
          {items.map((item, index) => {
            const distance =
              interactionIndex === undefined ? undefined : Math.min(3, Math.abs(index - interactionIndex));
            const visual = turnNavigatorBarVisualState(distance);
            const showScrollActiveColor = distance === undefined && index === activeIndex;
            return (
              <button
                key={item.key}
                type="button"
                className="conversation-turn-navigator-item"
                data-item-index={index}
                data-active={index === activeIndex ? "true" : "false"}
                data-visual-tone={visual.tone}
                aria-current={index === activeIndex ? "location" : undefined}
                aria-label={t("chat.turnNavigator.jumpToQuery", { index: index + 1 })}
                aria-posinset={index + 1}
                aria-setsize={items.length}
                onBlur={() => {
                  setInteractionIndex(undefined);
                  scheduleHide();
                  hoverIndexRef.current = undefined;
                  closeCard();
                }}
                onClick={() => onJumpToQuery(item, prefersReducedMotion ? "auto" : "smooth")}
                onFocus={() => {
                  cancelHide();
                  setRevealed(true);
                  setInteractionIndex(index);
                  hoverIndexRef.current = index;
                  openCard(index);
                }}
                onPointerEnter={() => {
                  setInteractionIndex(index);
                  hoverIndexRef.current = index;
                  openCard(index);
                }}
                onPointerLeave={() => {
                  setInteractionIndex(undefined);
                  hoverIndexRef.current = undefined;
                  closeCard();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  setInteractionIndex(undefined);
                  hoverIndexRef.current = undefined;
                  setCard(null);
                }}
              >
                <span
                  className="conversation-turn-navigator-bar"
                  data-visual-color-tone={visual.colorTone}
                  data-visual-scale={String(visual.scaleX)}
                  style={{
                    opacity: showScrollActiveColor ? 0.9 : visual.opacity,
                    transform: `scaleX(${visual.scaleX})`,
                  }}
                />
              </button>
            );
          })}
        </div>
      </nav>
      {card !== null &&
        createPortal(
          <div
            ref={cardRef}
            className="conversation-turn-navigator-card"
            data-turn-navigator-card=""
            role="tooltip"
            style={{ top: card.top, left: card.left }}
          >
            <p className="conversation-turn-navigator-card-text">{cardText}</p>
            {cardPreview !== "" && (
              <p className="conversation-turn-navigator-card-preview">{cardPreview}</p>
            )}
          </div>,
          document.body,
        )}
    </Fragment>
  );
});
