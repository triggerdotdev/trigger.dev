import { useSyncTrace } from "./useSyncTrace";
import { useSyncTraceRuns } from "./useSyncTraceRuns";

type Params = {
  origin: string;
  traceId: string;
};

export function useSyncRunPage({ origin, traceId }: Params) {
  const { runs } = useSyncTraceRuns({ origin, traceId });
  const { events } = useSyncTrace({ origin, traceId });

  const isUpToDate = runs !== undefined && events !== undefined;

  return { isUpToDate, runs, events };
}
