"use client";

import type { Middleware } from "swr";

/**
 * Middleware that logs if a fetcher is present. This helps detect cases where a global SWR fetcher
 * might be injected into hooks that are intended to manage their own data (e.g. realtime hooks).
 *
 * This middleware is non-invasive: it does not modify the fetcher or behavior, it only logs in dev.
 */
export function logIfFetcherPresent(label: string): Middleware {
  return (useSWRNext) => {
    return (key, fetcher, config) => {
      if (typeof fetcher === "function" && process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn(
          `[trigger.dev][${label}] Detected a fetcher for SWR key. This hook is intended to manage its own data; an inherited global SWR fetcher may cause unintended requests. key:`,
          key
        );
      }

      return useSWRNext(key, fetcher, config);
    };
  };
}


