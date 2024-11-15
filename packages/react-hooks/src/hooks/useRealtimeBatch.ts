"use client";

import { AnyTask, InferRunTypes, TaskRunShape } from "@trigger.dev/core/v3";
import { useEffect, useState } from "react";
import { useApiClient } from "./useApiClient.js";

/**
 * hook to subscribe to realtime updates of a batch of task runs.
 *
 * @template TTask - The type of the task.
 * @param {string} batchId - The unique identifier of the batch to subscribe to.
 * @returns {{ runs: TaskRunShape<TTask>[], error: Error | null }} An object containing the current state of the runs and any error encountered.
 *
 * @example
 *
 * ```ts
 * import type { myTask } from './path/to/task';
 * const { runs, error } = useRealtimeBatch<typeof myTask>('batch-id-123');
 * ```
 */
export function useRealtimeBatch<TTask extends AnyTask>(batchId: string) {
  const [runShapes, setRunShapes] = useState<TaskRunShape<TTask>[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const apiClient = useApiClient();

  useEffect(() => {
    const subscription = apiClient.subscribeToBatch<InferRunTypes<TTask>>(batchId);

    async function iterateUpdates() {
      for await (const run of subscription) {
        setRunShapes((prevRuns) => {
          return insertRunShapeInOrder(prevRuns, run);
        });
      }
    }

    iterateUpdates().catch((err) => {
      setError(err);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [batchId]);

  return { runs: runShapes, error };
}

// Inserts and then orders by the run number, and ensures that the run is not duplicated
function insertRunShapeInOrder<TTask extends AnyTask>(
  previousRuns: TaskRunShape<TTask>[],
  run: TaskRunShape<TTask>
) {
  const existingRun = previousRuns.find((r) => r.id === run.id);
  if (existingRun) {
    return previousRuns.map((r) => (r.id === run.id ? run : r));
  }

  const runNumber = run.number;
  const index = previousRuns.findIndex((r) => r.number > runNumber);
  if (index === -1) {
    return [...previousRuns, run];
  }

  return [...previousRuns.slice(0, index), run, ...previousRuns.slice(index)];
}
