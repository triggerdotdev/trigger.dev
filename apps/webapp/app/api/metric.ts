import { z } from "zod";

export const MetricQueryParams = z.object({
  startTime: z.union([z.string(), z.number()]),
  endTime: z.union([z.string(), z.number()]).optional(),
  /** A time period, e.g. 30s, 1m, 1h, 1d, etc. */
  granularity: z.string(),
  filters: z.object({
    task_identifier: z.string().optional(),
    status: z.string().optional(),
    queue: z.string().optional(),
  }).optional(),
  groupBy: z.string().optional(),
  /** Dynamic rollup configuration */
  rollup: z.object({
    type: z.enum(["count", "sum", "avg", "min", "max", "distinct"]),
    column: z.string(), // e.g., "usage_duration_ms", "cost_in_cents", "run_id"
  }).optional(),
});

export const MetricQuery = z
  .object({
    metric: z.string(),
  })
  .merge(MetricQueryParams);

export const MetricsQuery = z
  .object({
    metrics: z.union([z.array(z.string()), z.string()]),
  })
  .merge(MetricQueryParams);

export type MetricQuery = z.infer<typeof MetricQuery>;
export type MetricsQuery = z.infer<typeof MetricsQuery>;
export type MetricQueryParams = z.infer<typeof MetricQueryParams>;

export const MetricResultSeriesItem = z.object({});
