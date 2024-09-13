import { Prettify } from "@trigger.dev/core";
import { TaskRun } from "@trigger.dev/database";
import { SyncedShapeData, useSyncedShape } from "./useSyncedShape";

type Params = {
  origin: string;
  traceId: string;
};

export type RawRun = Prettify<SyncedShapeData<TaskRun>>;

export function useSyncTraceRuns({ origin, traceId }: Params) {
  const { data, error, isError } = useSyncedShape<TaskRun>({
    url: `${origin}/sync/traces/runs/${traceId}`,
  });

  return { runs: data, error, isError };
}
