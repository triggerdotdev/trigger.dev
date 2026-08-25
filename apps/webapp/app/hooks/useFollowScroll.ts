import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const AT_BOTTOM_TOLERANCE_PX = 4;

type FollowState = {
  follow: boolean;
  pinnedScrollTop: number | null;
  lastScrollTop: number;
  lastClientHeight: number;
};

export function useFollowScroll(containerRef: RefObject<HTMLElement | null>, content: unknown) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const stateRef = useRef<FollowState>({
    follow: true,
    pinnedScrollTop: null,
    lastScrollTop: 0,
    lastClientHeight: 0,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const state = stateRef.current;
    state.lastScrollTop = container.scrollTop;
    state.lastClientHeight = container.clientHeight;

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isEcho = scrollTop === state.pinnedScrollTop;
      const movedUp = scrollTop < state.lastScrollTop && clientHeight <= state.lastClientHeight;
      state.pinnedScrollTop = null;
      state.lastScrollTop = scrollTop;
      state.lastClientHeight = clientHeight;
      if (isEcho) return;

      state.follow = !movedUp && scrollHeight - scrollTop - clientHeight <= AT_BOTTOM_TOLERANCE_PX;
      setIsAtBottom(state.follow);
    };

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0 || !canScroll(container)) return;
      state.follow = false;
      setIsAtBottom(false);
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onWheel);
    };
  }, [containerRef]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container && stateRef.current.follow) pinToBottom(container, stateRef.current);
  }, [containerRef, isAtBottom, content]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      if (stateRef.current.follow) pinToBottom(container, stateRef.current);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);

  const scrollToBottom = () => {
    const container = containerRef.current;
    if (!container) return;
    stateRef.current.follow = true;
    setIsAtBottom(true);
    pinToBottom(container, stateRef.current);
  };

  const scrollToTop = () => {
    const container = containerRef.current;
    if (!container || !canScroll(container)) return;
    stateRef.current.follow = false;
    setIsAtBottom(false);
    container.scrollTop = 0;
  };

  return { isAtBottom, scrollToBottom, scrollToTop };
}

function pinToBottom(container: HTMLElement, state: FollowState) {
  container.scrollTop = container.scrollHeight;
  state.pinnedScrollTop = container.scrollTop;
  state.lastScrollTop = container.scrollTop;
  state.lastClientHeight = container.clientHeight;
}

function canScroll(container: HTMLElement) {
  return container.scrollHeight - container.clientHeight > AT_BOTTOM_TOLERANCE_PX;
}
