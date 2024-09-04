import { useSyncTrace } from "./useSyncTrace";
import { useSyncTraceRuns } from "./useSyncTraceRuns";

type Params = {
  origin: string;
  traceId: string;
};

export function useSyncRunPage({ origin, traceId }: Params) {
  const { isUpToDate: isRunUpToDate, runs } = useSyncTraceRuns({ origin, traceId });
  const { isUpToDate: isTraceUpToDate, events } = useSyncTrace({ origin, traceId });

  const isUpToDate = isRunUpToDate && isTraceUpToDate;

  return { isUpToDate, isRunUpToDate, isTraceUpToDate, runs, events };
}
