"use client";

import type { ApiRequestOptions } from "@trigger.dev/core/v3";
import { ApiClient, refreshAccessTokenOnce } from "@trigger.dev/core/v3";
import { useCallback, useEffect, useRef } from "react";
import { useTriggerAuthContextOptional } from "../contexts.js";

/**
 * Configuration options for creating an API client instance.
 */
export type UseApiClientOptions = {
  /** Optional access token for authentication */
  accessToken?: string;
  /** Optional base URL for the API endpoints */
  baseURL?: string;
  /** Optional preview branch name for preview environments */
  previewBranch?: string;
  /** Optional additional request configuration */
  requestOptions?: ApiRequestOptions;
  /**
   * Optional callback that mints a fresh access token. Used to reconnect a
   * realtime stream that the server rejected because its token expired.
   */
  refreshAccessToken?: () => Promise<string>;

  /**
   * Enable or disable the API client instance.
   *
   * Set enabled to false if you don't have an accessToken and don't want to throw an error.
   */
  enabled?: boolean;
};

/**
 * Hook to create an API client instance using authentication context or provided options.
 *
 * @param {UseApiClientOptions} [options] - Configuration options for the API client
 * @returns {ApiClient} An initialized API client instance
 * @throws {Error} When no access token is available in either context or options
 *
 * @example
 * ```ts
 * // Using context authentication
 * const apiClient = useApiClient();
 *
 * // Using custom options
 * const apiClient = useApiClient({
 *   accessToken: "your-access-token",
 *   baseURL: "https://api.my-trigger.com",
 *   requestOptions: { retry: { maxAttempts: 10 } }
 * });
 * ```
 */
export function useApiClient(options?: UseApiClientOptions): ApiClient | undefined {
  const auth = useTriggerAuthContextOptional();

  const baseUrl = options?.baseURL ?? auth?.baseURL ?? "https://api.trigger.dev";
  const accessToken = options?.accessToken ?? auth?.accessToken;
  const previewBranch = options?.previewBranch ?? auth?.previewBranch;
  const refreshAccessToken = options?.refreshAccessToken ?? auth?.refreshAccessToken;

  // A new ApiClient is built every render, so keep the refresher ref-stable and
  // key the dedupe on the caller's own function — every hook sharing one
  // refresher then shares one in-flight mint.
  const refreshAccessTokenRef = useRef(refreshAccessToken);
  useEffect(() => {
    refreshAccessTokenRef.current = refreshAccessToken;
  }, [refreshAccessToken]);
  const stableRefreshAccessToken = useCallback(async () => {
    const refresh = refreshAccessTokenRef.current;

    if (!refresh) {
      throw new Error("Missing refreshAccessToken in TriggerAuthContext or useApiClient options");
    }

    return refreshAccessTokenOnce(refresh);
  }, []);

  if (!accessToken) {
    if (options?.enabled === false) {
      return undefined;
    }

    throw new Error("Missing accessToken in TriggerAuthContext or useApiClient options");
  }

  const requestOptions: ApiRequestOptions = {
    ...auth?.requestOptions,
    ...options?.requestOptions,
  };

  return new ApiClient(
    baseUrl,
    accessToken,
    previewBranch,
    requestOptions,
    undefined,
    refreshAccessToken ? stableRefreshAccessToken : undefined
  );
}
