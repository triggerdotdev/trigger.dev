import { useShape } from "@electric-sql/react";
import { createTraceTreeFromEvents, prepareTrace } from "~/utils/taskEvent";
import { QueriedEvent } from "~/v3/eventRepository.server";

type TraceInput = {
  origin: string;
  traceId: string;
  spanId: string;
};

export type Trace = ReturnType<typeof createTraceTreeFromEvents>;
export type TraceEvent = NonNullable<Trace["events"][number]>;

export function useTrace({ origin, traceId, spanId }: TraceInput) {
  const { isUpToDate, data } = useShape({
    url: `${origin}/sync/traces/${traceId}`,
  });

  const events = prepareTrace(data as QueriedEvent[]);
  if (!events) {
    return { isUpToDate, trace: undefined };
  }

  const trace = createTraceTreeFromEvents(events, spanId);
  return { isUpToDate, trace };
}
