"use client";

import { ApiClient, ApiRequestOptions } from "@trigger.dev/core/v3";
import { useTriggerAuthContextOptional } from "../contexts.js";

export type UseApiClientOptions = {
  accessToken?: string;
  baseURL?: string;
  requestOptions?: ApiRequestOptions;
};

export function useApiClient(options?: UseApiClientOptions): ApiClient {
  const auth = useTriggerAuthContextOptional();

  const baseUrl = auth?.baseURL ?? options?.baseURL ?? "https://api.trigger.dev";
  const accessToken = auth?.accessToken ?? options?.accessToken;

  if (!accessToken) {
    throw new Error("Missing accessToken in TriggerAuthContext or useApiClient options");
  }

  const requestOptions: ApiRequestOptions = {
    ...auth?.requestOptions,
    ...options?.requestOptions,
  };

  return new ApiClient(baseUrl, accessToken, requestOptions);
}
