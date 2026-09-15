"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Keep subscription lifecycles controlled by their effects while using the
 * latest request inputs.
 */
export function useStableRequestCallback(callback: () => Promise<void>) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useCallback(() => callbackRef.current(), []);
}
