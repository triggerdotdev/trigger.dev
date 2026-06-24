import { useCallback } from "react";
import { type ChartZoomRange } from "~/components/primitives/charts/ChartSyncContext";
import { useSearchParams } from "~/hooks/useSearchParam";

/**
 * Returns an `onZoom` handler for chart drag-to-zoom that sets the Time/Date
 * filter to the selected range. Mirrors how `TimeFilter` applies a custom range:
 * epoch-ms `from`/`to`, clearing `period` (and pagination) so the page reloads
 * scoped to the dragged window.
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
