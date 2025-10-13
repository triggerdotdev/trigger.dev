import { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import { ClickhouseReader } from "./client/types.js";

// Result schemas for different metric types
export const MetricDataPoint = z.object({
  timestamp: z.string(),
  value: z.number(),
  label: z.string().optional(), // For groupBy values
});

export const MetricSeries = z.object({
  metric: z.string(),
  data: z.array(MetricDataPoint),
});

export const MetricResult = z.object({
  metric: z.string(),
  data: z.array(MetricDataPoint),
});

export type MetricDataPoint = z.infer<typeof MetricDataPoint>;
export type MetricSeries = z.infer<typeof MetricSeries>;
export type MetricResult = z.infer<typeof MetricResult>;

// Query parameter schemas
export const MetricQueryParams = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  startTime: z.union([z.string(), z.number()]),
  endTime: z.union([z.string(), z.number()]).optional(),
  granularity: z.string(), // e.g., "1m", "5m", "1h", "1d"
  filters: z
    .object({
      task_identifier: z.string().optional(),
      status: z.string().optional(),
      queue: z.string().optional(),
    })
    .optional(),
  groupBy: z.string().optional(), // e.g., "task_identifier", "status"
  // New fields for dynamic rollup and aggregation
  rollup: z
    .object({
      type: z.enum(["count", "sum", "avg", "min", "max", "distinct"]),
      column: z.string(), // e.g., "usage_duration_ms", "cost_in_cents", "run_id"
    })
    .optional(),
});

export type MetricQueryParams = z.infer<typeof MetricQueryParams>;

// Helper function to convert granularity to ClickHouse interval
function granularityToInterval(granularity: string): string {
  const match = granularity.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(
      `Invalid granularity format: ${granularity}. Expected format like "1m", "5m", "1h", "1d"`
    );
  }

  const [, amount, unit] = match;
  const unitMap = {
    s: "SECOND",
    m: "MINUTE",
    h: "HOUR",
    d: "DAY",
  };

  return `${amount} ${unitMap[unit as keyof typeof unitMap]}`;
}

// Helper function to get the appropriate time bucket function
function getTimeBucketFunction(granularity: string): string {
  const match = granularity.match(/^(\d+)([smhd])$/);
  if (!match) return "toStartOfMinute(toDateTime(created_at))";

  const [, amount, unit] = match;

  if (unit === "s" || unit === "m") {
    return `toStartOfMinute(toDateTime(created_at))`;
  } else if (unit === "h") {
    return `toStartOfHour(toDateTime(created_at))`;
  } else if (unit === "d") {
    return `toDate(toDateTime(created_at))`;
  }

  return "toStartOfMinute(toDateTime(created_at))";
}

// Helper function to build the aggregation expression
function buildAggregationExpression(
  rollupType: "count" | "sum" | "avg" | "min" | "max" | "distinct",
  column: string
): string {
  switch (rollupType) {
    case "count":
      return column === "*" ? "count()" : `count(${column})`;
    case "sum":
      return `sum(${column})`;
    case "avg":
      return `avg(${column})`;
    case "min":
      return `min(${column})`;
    case "max":
      return `max(${column})`;
    case "distinct":
      return `uniq(${column})`;
    default:
      return "count()";
  }
}

// Generic metrics query builder
export function getMetricsQueryBuilder(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilder({
    name: "getMetrics",
    baseQuery: `
      SELECT
        ${getTimeBucketFunction("1m")} as timestamp,
        count() as value
      FROM trigger_dev.task_runs_v2 FINAL
    `,
    schema: MetricResult,
    settings,
  });
}

// Dynamic metrics query builder with custom rollup and granularity
export function getDynamicMetricsQueryBuilder(
  ch: ClickhouseReader,
  granularity: string,
  rollupType: "count" | "sum" | "avg" | "min" | "max" | "distinct",
  column: string,
  settings?: ClickHouseSettings
) {
  const timeBucketFunction = getTimeBucketFunction(granularity);
  const aggregationExpression = buildAggregationExpression(rollupType, column);

  return ch.queryBuilder({
    name: `getDynamicMetrics_${rollupType}_${column}_${granularity}`,
    baseQuery: `
      SELECT
        ${timeBucketFunction} as timestamp,
        ${aggregationExpression} as value
      FROM trigger_dev.task_runs_v2 FINAL
    `,
    schema: MetricResult,
    settings,
  });
}

// Specific metric functions using the query builder pattern
export function getTaskRunCountMetrics(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilder({
    name: "getTaskRunCountMetrics",
    baseQuery: `
      SELECT
        ${getTimeBucketFunction("1m")} as timestamp,
        count() as value,
        task_identifier as label
      FROM trigger_dev.task_runs_v2 FINAL
    `,
    schema: MetricResult,
    settings,
  });
}

export function getTaskRunDurationMetrics(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilder({
    name: "getTaskRunDurationMetrics",
    baseQuery: `
      SELECT
        ${getTimeBucketFunction("1m")} as timestamp,
        avg(usage_duration_ms) as value,
        task_identifier as label
      FROM trigger_dev.task_runs_v2 FINAL
      WHERE usage_duration_ms > 0
    `,
    schema: MetricResult,
    settings,
  });
}

export function getTaskRunCostMetrics(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilder({
    name: "getTaskRunCostMetrics",
    baseQuery: `
      SELECT
        ${getTimeBucketFunction("1m")} as timestamp,
        sum(cost_in_cents) as value,
        task_identifier as label
      FROM trigger_dev.task_runs_v2 FINAL
      WHERE cost_in_cents > 0
    `,
    schema: MetricResult,
    settings,
  });
}

export function getTaskRunStatusMetrics(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilder({
    name: "getTaskRunStatusMetrics",
    baseQuery: `
      SELECT
        ${getTimeBucketFunction("1m")} as timestamp,
        count() as value,
        status as label
      FROM trigger_dev.task_runs_v2 FINAL
    `,
    schema: MetricResult,
    settings,
  });
}

// Advanced metrics with custom aggregation
export function getCustomMetrics(
  ch: ClickhouseReader,
  metric: string,
  aggregation: "count" | "sum" | "avg" | "min" | "max",
  column: string,
  settings?: ClickHouseSettings
) {
  const baseQuery = `
    SELECT
      ${getTimeBucketFunction("1m")} as timestamp,
      ${aggregation}(${column}) as value,
      task_identifier as label
    FROM trigger_dev.task_runs_v2 FINAL
  `;

  // Add WHERE clause for certain aggregations
  const whereClause =
    aggregation === "avg" || aggregation === "sum" || aggregation === "min" || aggregation === "max"
      ? `WHERE ${column} > 0`
      : "";

  return ch.queryBuilder({
    name: `getCustomMetrics_${metric}_${aggregation}`,
    baseQuery: baseQuery + whereClause,
    schema: MetricResult,
    settings,
  });
}

// Usage example function that shows how to use the query builders
export function createMetricsQuery(
  ch: ClickhouseReader,
  params: MetricQueryParams,
  metricType?: "count" | "duration" | "cost" | "status" | "custom",
  customMetric?: { aggregation: "count" | "sum" | "avg" | "min" | "max"; column: string }
) {
  let queryBuilder;

  // If rollup is specified, use dynamic metrics query builder
  if (params.rollup) {
    queryBuilder = getDynamicMetricsQueryBuilder(
      ch,
      params.granularity,
      params.rollup.type,
      params.rollup.column
    );
  } else if (metricType) {
    // Use predefined metric types
    switch (metricType) {
      case "count":
        queryBuilder = getTaskRunCountMetrics(ch);
        break;
      case "duration":
        queryBuilder = getTaskRunDurationMetrics(ch);
        break;
      case "cost":
        queryBuilder = getTaskRunCostMetrics(ch);
        break;
      case "status":
        queryBuilder = getTaskRunStatusMetrics(ch);
        break;
      case "custom":
        if (!customMetric) {
          throw new Error("customMetric is required for custom metric type");
        }
        queryBuilder = getCustomMetrics(
          ch,
          "custom",
          customMetric.aggregation,
          customMetric.column
        );
        break;
      default:
        throw new Error(`Unknown metric type: ${metricType}`);
    }
  } else {
    throw new Error("Either metricType or rollup must be specified");
  }

  // Build the query with filters
  const builder = queryBuilder();

  // Add standard filters
  builder
    .where("organization_id = {organizationId:String}", { organizationId: params.organizationId })
    .where("project_id = {projectId:String}", { projectId: params.projectId })
    .where("environment_id = {environmentId:String}", { environmentId: params.environmentId })
    .where("_is_deleted = 0")
    .where("created_at >= toUnixTimestamp({startTime:DateTime64})", {
      startTime: params.startTime,
    });

  if (params.endTime) {
    builder.where("created_at <= toUnixTimestamp({endTime:DateTime64})", {
      endTime: params.endTime,
    });
  }

  // Add optional filters
  if (params.filters?.task_identifier) {
    builder.where("task_identifier = {taskIdentifier:String}", {
      taskIdentifier: params.filters.task_identifier,
    });
  }

  if (params.filters?.status) {
    builder.where("status = {status:String}", { status: params.filters.status });
  }

  if (params.filters?.queue) {
    builder.where("queue = {queue:String}", { queue: params.filters.queue });
  }

  // Add grouping if specified
  if (params.groupBy && params.groupBy !== "task_identifier") {
    builder.groupBy(params.groupBy);
  } else if (!params.groupBy && !params.rollup) {
    // Only add default grouping for non-dynamic queries
    builder.groupBy("task_identifier");
  }

  // Add ordering
  builder.orderBy("timestamp ASC");

  return builder;
}
