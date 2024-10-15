"use client";

import { AnyTask, InferRunTypes, TaskRunShape } from "@trigger.dev/core/v3";
import { useEffect, useState } from "react";
import { useApiClient } from "./useApiClient.js";

/**
 * hook to subscribe to and manage the state of a task run.
 *
 * @template TTask - The type of the task.
 * @param {string} runId - The unique identifier of the run to subscribe to.
 * @returns {{ run: TaskRunShape<TTask> | undefined, error: Error | null }} An object containing the current state of the run and any error encountered.
 *
 * @example
 * ```ts
 * import type { myTask } from './path/to/task';
 * const { run, error } = useRun<typeof myTask>('run-id-123');
 * ```
 */
export function useRun<TTask extends AnyTask>(runId: string) {
  const [runShape, setRunShape] = useState<TaskRunShape<TTask> | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const apiClient = useApiClient();

  useEffect(() => {
    const subscription = apiClient.subscribeToRunChanges<InferRunTypes<TTask>>(runId);

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
