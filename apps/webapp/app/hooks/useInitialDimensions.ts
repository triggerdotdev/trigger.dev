import { useEffect, useLayoutEffect, useState } from "react";

export function useInitialDimensions(ref: React.RefObject<HTMLElement>) {
  const [dimensions, setDimensions] = useState<DOMRectReadOnly | null>(null);

  useEffect(() => {
    if (ref.current) {
      setDimensions(ref.current.getBoundingClientRect());
    }
  }, [ref]);

  return dimensions;
}
