import { useRef } from "react";

//a function that you call with a debounce delay, the function will only be called after the delay has passed
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
