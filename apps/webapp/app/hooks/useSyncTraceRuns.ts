import { useShape } from "@electric-sql/react";
import { TaskRun } from "@trigger.dev/database";
import { SyncedShapeData, useSyncedShape } from "./useSyncedShape";
import { Prettify } from "@trigger.dev/core";

type Params = {
  origin: string;
  traceId: string;
};

export type RawRun = Prettify<SyncedShapeData<TaskRun>>;

export function useSyncTraceRuns({ origin, traceId }: Params) {
  const { isUpToDate, data } = useSyncedShape<TaskRun>({
    url: `${origin}/sync/traces/runs/${traceId}`,
  });

  return { isUpToDate, runs: data };
}
