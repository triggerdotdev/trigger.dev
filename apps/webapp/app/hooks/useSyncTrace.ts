import { useShape } from "@electric-sql/react";
import { TaskEvent } from "@trigger.dev/database";
import { createTraceTreeFromEvents } from "~/utils/taskEvent";

type Params = {
  origin: string;
  traceId: string;
  spanId: string;
};

export type Trace = ReturnType<typeof createTraceTreeFromEvents>;
export type TraceEvent = NonNullable<Trace["events"][number]>;

export function useSyncTrace({ origin, traceId, spanId }: Params) {
  const { isUpToDate, data } = useShape({
    url: `${origin}/sync/traces/${traceId}`,
  });

  return { isUpToDate, events: data ? (data as unknown as TaskEvent[]) : undefined };
}
