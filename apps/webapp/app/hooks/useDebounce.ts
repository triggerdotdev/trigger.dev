import { useRef } from "react";

/**
 * A function that you call with a debounce delay, the function will only be called after the delay has passed
 *
 * @param fn The function to debounce
 * @param delay In ms
 */
export function useDebounce<T extends (...args: any[]) => any>(fn: T, delay: number) {
  const timeout = useRef<ReturnType<typeof setTimeout>>();

  return (...args: Parameters<T>) => {
    if (timeout.current) {
      clearTimeout(timeout.current);
    }

    timeout.current = setTimeout(() => {
      fn(...args);
    }, delay);
  };
}
