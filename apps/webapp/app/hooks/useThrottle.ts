import { useEffect, useRef } from "react";

export function useThrottle(fn: (...args: any[]) => void, duration: number) {
  const timeout = useRef<ReturnType<typeof setTimeout>>();

  // Clean up when the component is unmounted
  useEffect(() => {
    return () => {
      if (timeout.current) clearTimeout(timeout.current);
    };
  }, []);

  return (...args: Parameters<typeof fn>) => {
    if (timeout.current) {
      clearTimeout(timeout.current);
    }

    timeout.current = setTimeout(() => {
      fn(...args);
      timeout.current = undefined;
    }, duration);
  };
}
