import { startTransition, useEffect, useState } from "react";

/** The element's current size, updated whenever it resizes (window resize, panel drag). */
export function useDimensions(ref: React.RefObject<HTMLElement>) {
  const [dimensions, setDimensions] = useState<DOMRectReadOnly | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // A transition, so a measurement during hydration doesn't force Suspense boundaries
    // below it (deferred sections) to throw away their server HTML.
    const measure = () => startTransition(() => setDimensions(element.getBoundingClientRect()));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return dimensions;
}
