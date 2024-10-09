"use client";

import { useAuth } from "@/contexts/AuthContext";
import { ApiClient } from "@trigger.dev/core/v3";
import { AnyRunShape } from "@trigger.dev/sdk/v3";
import { useEffect, useState } from "react";

export function useRunSubscription(runId: string) {
  const [runUpdates, setRunUpdates] = useState<AnyRunShape[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const auth = useAuth();

  useEffect(() => {
    if (!runId) return;
    if (!auth || !auth.accessToken || !auth.baseURL) return;

    const apiClient = new ApiClient(auth.baseURL, auth.accessToken);
    const subscription = apiClient.subscribeToRunChanges(runId);

    async function iterateUpdates() {
      for await (const run of subscription) {
        setRunUpdates((prev) => [...prev, run]);
      }
    }

    iterateUpdates().catch((err) => {
      setError(err);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [runId, auth]);

  return { runUpdates, error };
}
