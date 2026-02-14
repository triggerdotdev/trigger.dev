import { TypeOf, z } from "zod";
import type { MachinePresetName } from "./common.js";
import type { RuntimeEnvironmentType } from "./common.js";
import type { IdempotencyKeyScope } from "../idempotency-key-catalog/catalog.js";

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
  results: z.array(z.record(z.any())),
});

export type QueryExecuteJSONResponseBody = z.infer<typeof QueryExecuteResponseBody>;

/**
 * Response body type for CSV format queries
 */
export const QueryExecuteCSVResponseBody = z.object({
  format: z.literal("csv"),
  results: z.string(),
});

export type QueryExecuteCSVResponseBody = z.infer<typeof QueryExecuteCSVResponseBody>;

export const QueryExecuteResponseBody = z.discriminatedUnion("format", [
  QueryExecuteJSONResponseBody,
  QueryExecuteCSVResponseBody,
]);
export type QueryExecuteResponseBody = z.infer<typeof QueryExecuteResponseBody>;

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
