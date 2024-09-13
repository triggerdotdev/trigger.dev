import { Prettify } from "@trigger.dev/core";
import { TaskRun } from "@trigger.dev/database";
import { SyncedShapeData, useSyncedShape } from "./useSyncedShape";
import { useEffect, useRef } from "react";

type Params = {
  origin: string;
  traceId: string;
};

export type RawRun = Prettify<SyncedShapeData<TaskRun>>;

export function useSyncTraceRuns({ origin, traceId }: Params) {
  const aborter = useRef(new AbortController());

  const { data, error, isError } = useSyncedShape<TaskRun>({
    url: `${origin}/sync/traces/runs/${traceId}`,
    signal: aborter.current.signal,
  });

  useEffect(() => {
    return () => {
      aborter.current.abort();
      aborter.current = new AbortController();
    };
  }, [origin, traceId]);

  return { runs: data, error, isError };
}
