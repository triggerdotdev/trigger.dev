"use client";

import { ApiRequestOptions } from "@trigger.dev/core/v3";

// eslint-disable-next-line import/export
export * from "swr";
// eslint-disable-next-line import/export
export { default as useSWR, SWRConfig } from "swr";
// Import the original useSWR separately for internal use
import { default as useSWROriginal } from "swr";

export type CommonTriggerHookOptions = {
  /**
   * Poll for updates at the specified interval (in milliseconds). Polling is not recommended for most use-cases. Use the Realtime hooks instead.
   */
  refreshInterval?: number;
  /** Revalidate the data when the browser regains a network connection. */
  revalidateOnReconnect?: boolean;
  /** Revalidate the data when the window regains focus. */
  revalidateOnFocus?: boolean;

  /** Optional access token for authentication */
  accessToken?: string;
  /** Optional base URL for the API endpoints */
  baseURL?: string;
  /** Optional additional request configuration */
  requestOptions?: ApiRequestOptions;
};

/**
 * Internal isolated useSWR hook that prevents global SWRConfig interference.
 * This should only be used by internal Trigger.dev hooks for state management.
 * 
 * For realtime hooks, this ensures that:
 * 1. No global fetcher will be invoked accidentally
 * 2. Internal state management remains isolated 
 * 3. Manual mutate() calls work as expected
 * 
 * @param key - SWR key for caching
 * @param fetcher - Fetcher function (should be null for internal state management)
 * @param config - SWR configuration options
 * @returns SWR hook result with isolated configuration
 */
export function useInternalSWR<Data = any, Error = any>(
  key: any,
  fetcher: ((key: any) => Data | Promise<Data>) | null = null,
  config: any = {}
) {
  // Always override fetcher to null and disable auto-revalidation for internal state management
  // This prevents global SWRConfig fetchers from being invoked
  const internalConfig = {
    // Disable automatic revalidation for internal state management
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    // Override any config that might cause global interference
    ...config,
    // Ensure fetcher remains null even if passed in config to prevent global fetcher usage
    fetcher: null,
  };

  return useSWROriginal(key, fetcher, internalConfig);
}
