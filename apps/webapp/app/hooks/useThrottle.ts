import { useRef } from "react";

export function useThrottle<T extends (...args: any[]) => any>(fn: T, delay: number) {
  const timeout = useRef<ReturnType<typeof setTimeout>>();

  return (...args: Parameters<T>) => {
    if (!timeout.current) {
      fn(...args);
      timeout.current = setTimeout(() => {
        timeout.current = undefined;
      }, delay);
    }
  };
}
