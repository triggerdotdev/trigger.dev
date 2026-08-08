import { useEffect, useLayoutEffect, useRef } from "react";

// How close to the bottom counts as following along.
const NEAR_BOTTOM_PX = 120;

type ScrollableMessage = { id: string; role?: string };

// Not `useAutoScrollToBottom`: it seeds stickiness from the position after first
// paint, so a restored transcript sits at scrollTop 0 and never scrolls again.
export function useTranscriptAutoScroll(
  messages: ReadonlyArray<ScrollableMessage>,
  activity: unknown
) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const followRef = useRef(true);
  // The last user message scrolled for, so the jump fires once per send.
  const jumpedForRef = useRef<string | undefined>(undefined);

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

  // Content also grows without a message change (lazy markdown, a card laying out).
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
