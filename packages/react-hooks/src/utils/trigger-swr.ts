"use client";

import { ApiRequestOptions } from "@trigger.dev/core/v3";

// eslint-disable-next-line import/export
export * from "swr";
// eslint-disable-next-line import/export
export { default as useSWR, SWRConfig } from "swr";

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
