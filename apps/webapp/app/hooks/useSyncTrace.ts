import { useShape } from "@electric-sql/react";
import { TaskEvent } from "@trigger.dev/database";
import { createTraceTreeFromEvents } from "~/utils/taskEvent";

type Params = {
  origin: string;
  traceId: string;
};

export type Trace = ReturnType<typeof createTraceTreeFromEvents>;
export type TraceEvent = Trace["events"][number];

export function useSyncTrace({ origin, traceId }: Params) {
  const { isUpToDate, data, error, isError } = useShape({
    url: `${origin}/sync/traces/${traceId}`,
  });

  return { isUpToDate, events: data ? (data as any as TaskEvent[]) : undefined };
}
