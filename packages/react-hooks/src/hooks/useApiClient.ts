"use client";

import { ApiClient, ApiRequestOptions } from "@trigger.dev/core/v3";
import { useTriggerAuthContextOptional } from "../contexts.js";

/**
 * Configuration options for creating an API client instance.
 */
export type UseApiClientOptions = {
  /** Optional access token for authentication */
  accessToken?: string;
  /** Optional base URL for the API endpoints */
  baseURL?: string;
  /** Optional additional request configuration */
  requestOptions?: ApiRequestOptions;
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
export function useApiClient(options?: UseApiClientOptions): ApiClient {
  const auth = useTriggerAuthContextOptional();

  const baseUrl = options?.baseURL ?? auth?.baseURL ?? "https://api.trigger.dev";
  const accessToken = options?.accessToken ?? auth?.accessToken;

  if (!accessToken) {
    throw new Error("Missing accessToken in TriggerAuthContext or useApiClient options");
  }

  const requestOptions: ApiRequestOptions = {
    ...auth?.requestOptions,
    ...options?.requestOptions,
  };

  return new ApiClient(baseUrl, accessToken, requestOptions);
}
