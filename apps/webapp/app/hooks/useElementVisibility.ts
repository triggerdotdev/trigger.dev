import { useEffect, useRef } from "react";

type UseElementVisibilityOptions = {
  onVisibilityChange?: (isVisible: boolean) => void;
};

export function useElementVisibility({
  onVisibilityChange,
}: UseElementVisibilityOptions = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const isVisibleRef = useRef(false);
  const callbackRef = useRef(onVisibilityChange);
  callbackRef.current = onVisibilityChange;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const nowVisible = entry.isIntersecting;
        if (isVisibleRef.current !== nowVisible) {
          isVisibleRef.current = nowVisible;
          callbackRef.current?.(nowVisible);
        }
      },
      { threshold: 0 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, isVisibleRef };
}
