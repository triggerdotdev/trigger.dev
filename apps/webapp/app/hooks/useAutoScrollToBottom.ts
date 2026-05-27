import { useEffect, useLayoutEffect, useRef } from "react";

const AT_BOTTOM_TOLERANCE_PX = 16;

/**
 * Chat-style sticky-bottom auto-scroll behavior.
 *
 * Behavior:
 * - On mount, finds the closest scrollable ancestor of the returned ref
 *   (the inspector content panel, the playground messages panel, etc.).
 * - Tracks whether the user is currently "at the bottom" of that scroll
 *   container via a passive scroll listener. Default is `true` so the very
 *   first render of an existing conversation lands at the bottom, and the
 *   "content fits without scrolling" case stays in auto-scroll mode.
 * - Whenever the dependency array changes (typically the messages array),
 *   if the user was at the bottom, programmatically scrolls to the new
 *   bottom. Uses `useLayoutEffect` so the scroll happens before paint and
 *   there's no one-frame flicker showing new content above the viewport.
 * - Scrolling away from the bottom flips the ref to `false` → auto-scroll
 *   pauses. Scrolling back into the bottom band (within
 *   `AT_BOTTOM_TOLERANCE_PX`) flips it back to `true` → auto-scroll
 *   resumes.
 *
 * The programmatic scroll fires its own scroll event, which immediately
 * re-runs the stickiness check and confirms we're still at the bottom
 * (distance ≈ 0 ≤ tolerance), so the ref stays `true`. No special
 * "ignore programmatic scroll" flag needed.
 *
 * @param deps  Pass the rendered list (or any dependency that should
 *              trigger a re-scroll). Typically `[messages]`.
 * @returns     A ref to attach to the component's root element. The hook
 *              walks up from this element's parent to locate the scroll
 *              container, so the root must be mounted *inside* the
 *              scrollable region.
 *
 * @example
 * ```tsx
 * function ChatPanel({ messages }) {
 *   const rootRef = useAutoScrollToBottom([messages]);
 *   return (
 *     <div className="overflow-y-auto h-full">
 *       <div ref={rootRef}>
 *         {messages.map((m) => <Message key={m.id} message={m} />)}
 *       </div>
 *     </div>
 *   );
 * }
 * ```
 */
export function useAutoScrollToBottom(deps: ReadonlyArray<unknown>) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  // Default true so initial mount + replay land at the bottom, and the
  // no-overflow case stays sticky once content starts to grow.
  const stickToBottomRef = useRef(true);

  // Locate the scroll container on mount and attach a passive scroll
  // listener that updates `stickToBottomRef`.
  useEffect(() => {
    const findScrollContainer = (start: HTMLElement | null): HTMLElement | null => {
      let current: HTMLElement | null = start;
      while (current) {
        const style = getComputedStyle(current);
        const overflowY = style.overflowY;
        if (overflowY === "auto" || overflowY === "scroll") return current;
        current = current.parentElement;
      }
      return null;
    };

    const container = findScrollContainer(rootRef.current?.parentElement ?? null);
    if (!container) return;
    containerRef.current = container;

    const updateStickiness = () => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      stickToBottomRef.current = distanceFromBottom <= AT_BOTTOM_TOLERANCE_PX;
    };

    // Seed from current position so the first messages-effect uses an
    // accurate value rather than the default `true` if the user happened
    // to mount the view already scrolled.
    updateStickiness();

    container.addEventListener("scroll", updateStickiness, { passive: true });
    return () => {
      container.removeEventListener("scroll", updateStickiness);
      containerRef.current = null;
    };
  }, []);

  // After each commit that changes the deps (typically the messages
  // array), if we were at the bottom, scroll to the new bottom.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return rootRef;
}
