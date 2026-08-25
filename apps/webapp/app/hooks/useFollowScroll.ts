import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

const AT_BOTTOM_TOLERANCE_PX = 4;

export function useFollowScroll(containerRef: RefObject<HTMLElement | null>, content: unknown) {
  const [isAtBottom, setIsAtBottom] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let lastScrollTop = container.scrollTop;

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distance = scrollHeight - scrollTop - clientHeight;
      const movedUp = scrollTop < lastScrollTop && distance > 1;
      lastScrollTop = scrollTop;
      setIsAtBottom(!movedUp && distance <= AT_BOTTOM_TOLERANCE_PX);
    };

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && canScroll(container)) setIsAtBottom(false);
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
    if (!isAtBottom || !container) return;
    container.scrollTop = container.scrollHeight;
  }, [containerRef, isAtBottom, content]);

  useEffect(() => {
    const container = containerRef.current;
    if (!isAtBottom || !container) return;

    const observer = new ResizeObserver(() => {
      container.scrollTop = container.scrollHeight;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, isAtBottom]);

  const scrollToBottom = () => {
    const container = containerRef.current;
    if (!container) return;
    setIsAtBottom(true);
    container.scrollTop = container.scrollHeight;
  };

  const scrollToTop = () => {
    const container = containerRef.current;
    if (!container || !canScroll(container)) return;
    setIsAtBottom(false);
    container.scrollTop = 0;
  };

  return { isAtBottom, scrollToBottom, scrollToTop };
}

function canScroll(container: HTMLElement) {
  return container.scrollHeight - container.clientHeight > AT_BOTTOM_TOLERANCE_PX;
}
