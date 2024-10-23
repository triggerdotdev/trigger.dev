"use client";

import { ApiClient } from "@trigger.dev/core/v3";
import { useTriggerAuthContext } from "../contexts.js";

export function useApiClient() {
  const auth = useTriggerAuthContext();

  const baseUrl = auth.baseURL ?? "https://api.trigger.dev";

  if (!auth.accessToken) {
    throw new Error("Missing accessToken in TriggerAuthContext");
  }

  return new ApiClient(baseUrl, auth.accessToken, auth.requestOptions);
}
