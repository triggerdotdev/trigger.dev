"use client";

import { ApiClient } from "@trigger.dev/core/v3";
import { useTriggerAuthContext } from "../contexts.js";

export function useApiClient() {
  const auth = useTriggerAuthContext();

  if (!auth.baseURL || !auth.accessToken) {
    throw new Error("Missing baseURL or accessToken in TriggerAuthContext");
  }

  return new ApiClient(auth.baseURL, auth.accessToken, auth.requestOptions);
}
