import { useSyncRun } from "./useSyncRun";
import { useSyncTrace } from "./useSyncTrace";

type Params = {
  origin: string;
  runId: string;
  traceId: string;
  spanId: string;
};

export function useSyncRunPage({ origin, runId, traceId, spanId }: Params) {
  const { isUpToDate: isRunUpToDate, run } = useSyncRun({ origin, runId });
  const { isUpToDate: isTraceUpToDate, events } = useSyncTrace({ origin, traceId, spanId });

  const isUpToDate = isRunUpToDate && isTraceUpToDate;

  return { isUpToDate, isRunUpToDate, isTraceUpToDate, run, events };
}
