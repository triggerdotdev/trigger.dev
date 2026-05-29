import type { AggregationType } from "~/components/metrics/QueryWidget";

/**
 * Aggregate an array of numbers using the specified aggregation function.
 *
 * Shared utility so both QueryResultsChart (data transformation) and chart
 * legend components can reuse the same logic without circular imports.
 */
export function aggregateValues(values: number[], aggregation: AggregationType): number {
  if (values.length === 0) return 0;
  switch (aggregation) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "count":
      return values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
  }
}
