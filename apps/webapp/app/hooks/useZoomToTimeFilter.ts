import { useCallback } from "react";
import { type ChartZoomRange } from "~/components/primitives/charts/ChartSyncContext";
import { useSearchParams } from "~/hooks/useSearchParam";

/**
 * `onZoom` handler that sets the Time/Date filter to the dragged range, the same
 * way TimeFilter applies a custom range: epoch-ms `from`/`to`, clearing `period`
 * and pagination so the page reloads scoped to that window.
 */
export function useZoomToTimeFilter() {
  const { replace } = useSearchParams();

  return useCallback(
    (range: ChartZoomRange) => {
      replace({
        period: undefined,
        cursor: undefined,
        direction: undefined,
        from: Math.round(range.start).toString(),
        to: Math.round(range.end).toString(),
      });
    },
    [replace]
  );
}
