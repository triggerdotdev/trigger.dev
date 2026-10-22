import { z } from "zod/v4";
import { discriminatedUnion } from "../utils/zod.js";
import type { IdempotencyKeyScope } from "../idempotency-key-catalog/catalog.js";
import type { MachinePresetName, RuntimeEnvironmentType } from "./common.js";

/**
 * Request body schema for executing a query
 */
export const QueryExecuteRequestBody = z.object({
  query: z.string(),
  scope: z.enum(["organization", "project", "environment"]).default("environment"),
  period: z.string().nullish(),
  from: z.string().nullish(),
  to: z.string().nullish(),
  format: z.enum(["json", "csv"]).default("json"),
});

export type QueryExecuteRequestBody = z.infer<typeof QueryExecuteRequestBody>;

/**
 * Response body schema for JSON format queries
 */
export const QueryExecuteJSONResponseBody = z.object({
  format: z.literal("json"),
  results: z.array(z.record(z.string(), z.any())),
});

export type QueryExecuteJSONResponseBody = z.infer<typeof QueryExecuteJSONResponseBody>;

/**
 * Response body type for CSV format queries
 */
export const QueryExecuteCSVResponseBody = z.object({
  format: z.literal("csv"),
  results: z.string(),
});

export type QueryExecuteCSVResponseBody = z.infer<typeof QueryExecuteCSVResponseBody>;

export const QueryExecuteResponseBody = discriminatedUnion("format", [
  QueryExecuteJSONResponseBody,
  QueryExecuteCSVResponseBody,
]);
export type QueryExecuteResponseBody = z.infer<typeof QueryExecuteResponseBody>;

// ---------------------------------------------------------------------------
// Query schema discovery types
// ---------------------------------------------------------------------------

/**
 * Schema for a single column in the query schema response
 */
export const QuerySchemaColumn = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().optional(),
  example: z.string().optional(),
  allowedValues: z.array(z.string()).optional(),
  coreColumn: z.boolean().optional(),
});

export type QuerySchemaColumn = z.infer<typeof QuerySchemaColumn>;

/**
 * Schema for a single table in the query schema response
 */
export const QuerySchemaTable = z.object({
  name: z.string(),
  description: z.string().optional(),
  timeColumn: z.string().optional(),
  columns: z.array(QuerySchemaColumn),
});

export type QuerySchemaTable = z.infer<typeof QuerySchemaTable>;

/**
 * Response body for the query schema endpoint
 */
export const QuerySchemaResponseBody = z.object({
  tables: z.array(QuerySchemaTable),
});

export type QuerySchemaResponseBody = z.infer<typeof QuerySchemaResponseBody>;

// ---------------------------------------------------------------------------
// Dashboard types
// ---------------------------------------------------------------------------

/**
 * Summary of a widget in a dashboard (for listing)
 */
export const DashboardWidgetSummary = z.object({
  id: z.string(),
  title: z.string(),
  query: z.string(),
  type: z.enum(["bignumber", "chart", "table", "title"]),
});

export type DashboardWidgetSummary = z.infer<typeof DashboardWidgetSummary>;

/**
 * Summary of a dashboard (for listing)
 */
export const DashboardSummary = z.object({
  key: z.string(),
  title: z.string(),
  /** `builtIn` dashboards are read-only; `custom` dashboards can be edited through the API */
  type: z.enum(["builtIn", "custom"]).optional(),
  description: z.string().optional(),
  widgets: z.array(DashboardWidgetSummary),
});

export type DashboardSummary = z.infer<typeof DashboardSummary>;

/**
 * Response body for listing dashboards
 */
export const ListDashboardsResponseBody = z.object({
  dashboards: z.array(DashboardSummary),
});

export type ListDashboardsResponseBody = z.infer<typeof ListDashboardsResponseBody>;

export const DashboardChartType = z.enum(["bar", "line"]);
export type DashboardChartType = z.infer<typeof DashboardChartType>;

export const DashboardSortDirection = z.enum(["asc", "desc"]);
export type DashboardSortDirection = z.infer<typeof DashboardSortDirection>;

export const DashboardChartAggregation = z.enum(["sum", "avg", "count", "min", "max"]);
export type DashboardChartAggregation = z.infer<typeof DashboardChartAggregation>;

export const DashboardBigNumberAggregation = z.enum([
  "sum",
  "avg",
  "count",
  "min",
  "max",
  "first",
  "last",
]);
export type DashboardBigNumberAggregation = z.infer<typeof DashboardBigNumberAggregation>;

export const DashboardChartConfig = z.object({
  chartType: DashboardChartType,
  xAxisColumn: z.string().nullable(),
  yAxisColumns: z.string().array(),
  groupByColumn: z.string().nullable(),
  stacked: z.boolean(),
  sortByColumn: z.string().nullable(),
  sortDirection: DashboardSortDirection,
  aggregation: DashboardChartAggregation,
  seriesColors: z.record(z.string(), z.string()).optional(),
});
export type DashboardChartConfig = z.infer<typeof DashboardChartConfig>;

export const DashboardBigNumberConfig = z.object({
  column: z.string(),
  aggregation: DashboardBigNumberAggregation,
  sortDirection: DashboardSortDirection.optional(),
  abbreviate: z.boolean().default(false),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
});
export type DashboardBigNumberConfig = z.infer<typeof DashboardBigNumberConfig>;

/**
 * How a dashboard widget renders its query results.
 */
export const DashboardWidgetDisplay = discriminatedUnion("type", [
  z.object({
    type: z.literal("table"),
    prettyFormatting: z.boolean().default(true),
    sorting: z.array(z.object({ desc: z.boolean(), id: z.string() })).default([]),
  }),
  DashboardChartConfig.extend({ type: z.literal("chart") }),
  DashboardBigNumberConfig.extend({ type: z.literal("bignumber") }),
  z.object({ type: z.literal("title") }),
]);
export type DashboardWidgetDisplay = z.infer<typeof DashboardWidgetDisplay>;

/**
 * A widget's position on the dashboard's 12-column grid.
 */
export const DashboardLayoutItem = z.object({
  i: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  minH: z.number().optional(),
  maxH: z.number().optional(),
});
export type DashboardLayoutItem = z.infer<typeof DashboardLayoutItem>;

export const DashboardStoredWidget = z.object({
  title: z.string(),
  query: z.string().default(""),
  display: DashboardWidgetDisplay,
  /** Server-side gap fill: carry-forward for gauges, zero-fill for counters. */
  fillGaps: z.boolean().optional(),
});
export type DashboardStoredWidget = z.infer<typeof DashboardStoredWidget>;

/**
 * The stored definition of a dashboard: every widget and its grid position.
 */
export const DashboardDefinition = discriminatedUnion("version", [
  z.object({
    version: z.literal("1"),
    layout: z.array(DashboardLayoutItem),
    widgets: z.record(z.string(), DashboardStoredWidget),
  }),
]);
export type DashboardDefinition = z.infer<typeof DashboardDefinition>;

export const DashboardWidgetPosition = z.object({
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1),
});
export type DashboardWidgetPosition = z.infer<typeof DashboardWidgetPosition>;

/**
 * A widget as the dashboards API reads and writes it.
 */
export const DashboardWidget = z.object({
  id: z.string(),
  title: z.string(),
  query: z.string(),
  display: DashboardWidgetDisplay,
  fillGaps: z.boolean().optional(),
  position: DashboardWidgetPosition,
});
export type DashboardWidget = z.infer<typeof DashboardWidget>;

/**
 * A custom dashboard as the dashboards API returns it.
 */
export const DashboardObject = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  /** Changes on every write. Send it back as `revision` to reject a write that would overwrite someone else's change. */
  revision: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  widgets: z.array(DashboardWidget),
});
export type DashboardObject = z.infer<typeof DashboardObject>;

const DashboardWidgetTitle = z.string().trim().min(1).max(200);

export const DashboardWidgetInput = z.strictObject({
  /** Omit to generate one. Must be unique within the dashboard. */
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "id may only contain letters, numbers, _ and -")
    .optional(),
  title: DashboardWidgetTitle,
  /** A TRQL query. Required unless `display.type` is `title`. */
  query: z.string().default(""),
  display: DashboardWidgetDisplay,
  fillGaps: z.boolean().optional(),
  /** Omit to place the widget full width below the existing widgets. */
  position: DashboardWidgetPosition.optional(),
});
export type DashboardWidgetInput = z.input<typeof DashboardWidgetInput>;

const DashboardTitle = z.string().trim().min(1).max(200);
const DashboardDescription = z.string().max(2000);

export const CreateDashboardRequestBody = z.strictObject({
  title: DashboardTitle,
  description: DashboardDescription.optional(),
  widgets: z.array(DashboardWidgetInput).optional(),
});
export type CreateDashboardRequestBody = z.input<typeof CreateDashboardRequestBody>;

export const UpdateDashboardRequestBody = z.strictObject({
  title: DashboardTitle.optional(),
  description: DashboardDescription.optional(),
  revision: z.string().optional(),
});
export type UpdateDashboardRequestBody = z.input<typeof UpdateDashboardRequestBody>;

export const ReplaceDashboardRequestBody = z.strictObject({
  title: DashboardTitle.optional(),
  description: DashboardDescription.optional(),
  widgets: z.array(DashboardWidgetInput),
  revision: z.string().optional(),
});
export type ReplaceDashboardRequestBody = z.input<typeof ReplaceDashboardRequestBody>;

export const AddDashboardWidgetRequestBody = DashboardWidgetInput.extend({
  revision: z.string().optional(),
});
export type AddDashboardWidgetRequestBody = z.input<typeof AddDashboardWidgetRequestBody>;

export const UpdateDashboardWidgetRequestBody = z.strictObject({
  title: DashboardWidgetTitle.optional(),
  query: z.string().optional(),
  display: DashboardWidgetDisplay.optional(),
  fillGaps: z.boolean().optional(),
  position: DashboardWidgetPosition.optional(),
  revision: z.string().optional(),
});
export type UpdateDashboardWidgetRequestBody = z.input<typeof UpdateDashboardWidgetRequestBody>;

export const AddDashboardWidgetResponseBody = z.object({
  widgetId: z.string(),
  dashboard: DashboardObject,
});
export type AddDashboardWidgetResponseBody = z.infer<typeof AddDashboardWidgetResponseBody>;

export const DeleteDashboardResponseBody = z.object({ id: z.string() });
export type DeleteDashboardResponseBody = z.infer<typeof DeleteDashboardResponseBody>;

// ---------------------------------------------------------------------------
// Query table row types
// ---------------------------------------------------------------------------

/**
 * User-facing friendly run status values returned by the query system.
 */
export const runFriendlyStatus = [
  "Delayed",
  "Queued",
  "Pending version",
  "Dequeued",
  "Executing",
  "Waiting",
  "Reattempting",
  "Paused",
  "Canceled",
  "Interrupted",
  "Completed",
  "Failed",
  "System failure",
  "Crashed",
  "Expired",
  "Timed out",
] as const;

export type RunFriendlyStatus = (typeof runFriendlyStatus)[number];

/**
 * Full row type for the `runs` query table.
 *
 * Each property corresponds to a column available in TSQL queries against the
 * `runs` table. Types are mapped from the underlying ClickHouse column types:
 *
 * - `String` → `string`
 * - `UInt8` / `UInt32` / `Int64` / `Float64` → `number`
 * - `DateTime64` → `string`
 * - `Nullable(X)` → `X | null`
 * - `Array(String)` → `string[]`
 * - `JSON` → `Record<string, unknown>`
 * - `LowCardinality(String)` with constrained values → narrow union type
 */
export interface RunsTableRow {
  /** Unique run ID (e.g. `run_cm1a2b3c4d5e6f7g8h9i`) */
  run_id: string;
  /** Environment slug */
  environment: string;
  /** Project reference (e.g. `proj_howcnaxbfxdmwmxazktx`) */
  project: string;
  /** Environment type */
  environment_type: RuntimeEnvironmentType;
  /** Number of attempts (starts at 1) */
  attempt_count: number;
  /** Run status (friendly name) */
  status: RunFriendlyStatus;
  /** Whether the run is finished (0 or 1) */
  is_finished: number;
  /** Task identifier/slug */
  task_identifier: string;
  /** Queue name */
  queue: string;
  /** Batch ID (if part of a batch), or `null` */
  batch_id: string | null;
  /** Root run ID (for child runs), or `null` */
  root_run_id: string | null;
  /** Parent run ID (for child runs), or `null` */
  parent_run_id: string | null;
  /** Nesting depth (0 for root runs) */
  depth: number;
  /** Whether this is a root run (0 or 1) */
  is_root_run: number;
  /** Whether this is a child run (0 or 1) */
  is_child_run: number;
  /** Idempotency key */
  idempotency_key: string;
  /** Idempotency key scope (empty string means no idempotency key is set) */
  idempotency_key_scope: IdempotencyKeyScope | "";
  /** Region, or `null` */
  region: string | null;
  /** When the run was triggered (ISO 8601) */
  triggered_at: string;
  /** When the run was queued, or `null` */
  queued_at: string | null;
  /** When the run was dequeued, or `null` */
  dequeued_at: string | null;
  /** When execution began, or `null` */
  executed_at: string | null;
  /** When the run completed, or `null` */
  completed_at: string | null;
  /** Delayed execution until this time, or `null` */
  delay_until: string | null;
  /** Whether the run had a delay (0 or 1) */
  has_delay: number;
  /** When the run expired, or `null` */
  expired_at: string | null;
  /** TTL string for expiration (e.g. `"10m"`) */
  ttl: string;
  /** Time from execution start to completion in ms, or `null` */
  execution_duration: number | null;
  /** Time from trigger to completion in ms, or `null` */
  total_duration: number | null;
  /** Time from queued to dequeued in ms, or `null` */
  queued_duration: number | null;
  /** Compute usage duration in ms */
  usage_duration: number;
  /** Compute cost in dollars */
  compute_cost: number;
  /** Invocation cost in dollars */
  invocation_cost: number;
  /** Total cost in dollars (compute + invocation) */
  total_cost: number;
  /** The data returned from the task */
  output: Record<string, unknown>;
  /** Error data if the run failed */
  error: Record<string, unknown>;
  /** Tags added to the run */
  tags: string[];
  /** Code version in reverse date format (e.g. `"20240115.1"`) */
  task_version: string;
  /** SDK package version */
  sdk_version: string;
  /** CLI package version */
  cli_version: string;
  /** Machine preset the run executed on */
  machine: MachinePresetName;
  /** Whether this is a test run (0 or 1) */
  is_test: number;
  /** Concurrency key passed when triggering */
  concurrency_key: string;
  /** Max allowed compute duration in seconds, or `null` */
  max_duration: number | null;
  /** Bulk action group IDs that operated on this run */
  bulk_action_group_ids: string[];
}

/** @internal Map of query table names to their full row types */
type QueryTableMap = {
  runs: RunsTableRow;
};

/**
 * Type helper for Query results.
 *
 * @example
 * ```typescript
 * // All columns from the runs table
 * type AllRuns = QueryTable<"runs">;
 *
 * // Only specific columns
 * type MyResult = QueryTable<"runs", "status" | "run_id">;
 *
 * // Access a single field type
 * type Status = QueryTable<"runs">["status"]; // RunFriendlyStatus
 *
 * // Use with query.execute
 * const result = await query.execute<QueryTable<"runs", "status" | "run_id">>(
 *   "SELECT status, run_id FROM runs"
 * );
 * ```
 */
export type QueryTable<
  TTable extends keyof QueryTableMap,
  TColumns extends keyof QueryTableMap[TTable] = keyof QueryTableMap[TTable],
> = Pick<QueryTableMap[TTable], TColumns>;
