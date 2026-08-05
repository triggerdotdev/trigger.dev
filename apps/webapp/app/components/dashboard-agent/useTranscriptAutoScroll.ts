import { useEffect, useLayoutEffect, useRef } from "react";

/** How close to the bottom counts as following along. */
const NEAR_BOTTOM_PX = 120;

type ScrollableMessage = { id: string; role?: string };

/**
 * Sticky-bottom scrolling for the chat transcript. Three rules:
 *
 * 1. A message the user just sent always jumps to the bottom, however far up
 *    they had scrolled.
 * 2. Streamed content only follows while they are already near the bottom.
 * 3. Mounting lands at the bottom: the panel remounts the chat on every page
 *    navigation, and a restored transcript opening at the top reads as empty.
 *
 * The shared `useAutoScrollToBottom` can't do 1 or 3: it seeds its stickiness
 * from the scroll position after the first paint, so a restored transcript sits
 * at scrollTop 0, is judged not at the bottom, and never scrolls again.
 *
 * @returns the ref for the content column inside the scroller.
 */
export function useTranscriptAutoScroll(
  messages: ReadonlyArray<ScrollableMessage>,
  activity: unknown
) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const followRef = useRef(true);
  // The last user message scrolled for, so rule 1 fires once per send.
  const jumpedForRef = useRef<string | undefined>(undefined);

  // Find the scroller, land at the bottom, and track whether we're following.
  useLayoutEffect(() => {
    let element: HTMLElement | null = contentRef.current?.parentElement ?? null;
    while (element) {
      const overflowY = getComputedStyle(element).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") break;
      element = element.parentElement;
    }
    if (!element) return;
    const container = element;
    containerRef.current = container;
    container.scrollTop = container.scrollHeight;

    const onScroll = () => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      followRef.current = distance <= NEAR_BOTTOM_PX;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      containerRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const last = messages[messages.length - 1];
    const sent = last?.role === "user" && jumpedForRef.current !== last.id;
    if (sent) jumpedForRef.current = last!.id;
    if (!sent && !followRef.current) return;

    followRef.current = true;
    container.scrollTop = container.scrollHeight;
  }, [messages, activity]);

  // Content also grows without a message change (lazy markdown, a card laying
  // out). Follow that too, but only while following.
  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (followRef.current) container.scrollTop = container.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return contentRef;
}
