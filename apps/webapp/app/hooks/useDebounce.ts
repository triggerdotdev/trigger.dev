import { useEffect, useRef } from "react";

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

/**
 * A function that takes in a value, function, and delay.
 * It will run the function with the debounced value, only if the value has changed.
 * It should deal with the function being passed in not being a useCallback
 */
export function useDebounceEffect<T>(value: T, fn: (value: T) => void, delay: number) {
  const fnRef = useRef(fn);

  // Update the ref whenever the function changes
  fnRef.current = fn;

  useEffect(() => {
    const timeout = setTimeout(() => {
      fnRef.current(value);
    }, delay);

    return () => {
      clearTimeout(timeout);
    };
  }, [value, delay]); // Only depend on value and delay, not fn
}
