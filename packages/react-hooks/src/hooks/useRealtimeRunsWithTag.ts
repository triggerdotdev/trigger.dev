"use client";

import { AnyTask, InferRunTypes, TaskRunShape } from "@trigger.dev/core/v3";
import { useEffect, useState } from "react";
import { useApiClient } from "./useApiClient.js";

export function useRealtimeRunsWithTag<TTask extends AnyTask>(tag: string | string[]) {
  const [runShapes, setRunShapes] = useState<TaskRunShape<TTask>[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const apiClient = useApiClient();

  useEffect(() => {
    const subscription = apiClient.subscribeToRunsWithTag<InferRunTypes<TTask>>(tag);

    async function iterateUpdates() {
      for await (const run of subscription) {
        setRunShapes((prevRuns) => {
          return insertRunShape(prevRuns, run);
        });
      }
    }

    iterateUpdates().catch((err) => {
      setError(err);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [tag]);

  return { runs: runShapes, error };
}

function stableSortTags(tag: string | string[]) {
  return Array.isArray(tag) ? tag.slice().sort() : [tag];
}

// Replaces or inserts a run shape, ordered by the createdAt timestamp
function insertRunShape<TTask extends AnyTask>(
  previousRuns: TaskRunShape<TTask>[],
  run: TaskRunShape<TTask>
) {
  const existingRun = previousRuns.find((r) => r.id === run.id);
  if (existingRun) {
    return previousRuns.map((r) => (r.id === run.id ? run : r));
  }

  const createdAt = run.createdAt;

  const index = previousRuns.findIndex((r) => r.createdAt > createdAt);

  if (index === -1) {
    return [...previousRuns, run];
  }

  return [...previousRuns.slice(0, index), run, ...previousRuns.slice(index)];
}
