"use client";

import { AnyTask, TaskRunShape } from "@trigger.dev/core/v3";
import { useEffect, useState } from "react";
import { useApiClient } from "./useApiClient.js";

export function useRun<TTask extends AnyTask>(runId: string) {
  const [runShape, setRunShape] = useState<TaskRunShape<TTask> | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const apiClient = useApiClient();

  useEffect(() => {
    const subscription = apiClient.subscribeToRunChanges(runId);

    async function iterateUpdates() {
      for await (const run of subscription) {
        setRunShape(run);
      }
    }

    iterateUpdates().catch((err) => {
      setError(err);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [runId]);

  return { run: runShape, error };
}
