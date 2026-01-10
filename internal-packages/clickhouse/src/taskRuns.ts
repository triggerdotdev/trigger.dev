import { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import { ClickhouseReader, ClickhouseWriter } from "./client/types.js";

export const TaskRunV2 = z.object({
  environment_id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  run_id: z.string(),
  updated_at: z.number().int(),
  created_at: z.number().int(),
  status: z.string(),
  environment_type: z.string(),
  friendly_id: z.string(),
  attempt: z.number().int().default(1),
  engine: z.string(),
  task_identifier: z.string(),
  queue: z.string(),
  schedule_id: z.string(),
  batch_id: z.string(),
  completed_at: z.number().int().nullish(),
  started_at: z.number().int().nullish(),
  executed_at: z.number().int().nullish(),
  delay_until: z.number().int().nullish(),
  queued_at: z.number().int().nullish(),
  expired_at: z.number().int().nullish(),
  usage_duration_ms: z.number().int().default(0),
  cost_in_cents: z.number().default(0),
  base_cost_in_cents: z.number().default(0),
  output: z.unknown(),
  error: z.unknown(),
  tags: z.array(z.string()).default([]),
  task_version: z.string(),
  sdk_version: z.string(),
  cli_version: z.string(),
  machine_preset: z.string(),
  root_run_id: z.string(),
  parent_run_id: z.string(),
  depth: z.number().int().default(0),
  span_id: z.string(),
  trace_id: z.string(),
  idempotency_key: z.string(),
  expiration_ttl: z.string(),
  is_test: z.boolean().default(false),
  concurrency_key: z.string().default(""),
  bulk_action_group_ids: z.array(z.string()).default([]),
  worker_queue: z.string().default(""),
  max_duration_in_seconds: z.number().int().nullish(),
  _version: z.string(),
  _is_deleted: z.number().int().default(0),
});

export type TaskRunV2 = z.input<typeof TaskRunV2>;

// Column order for compact format - must match ClickHouse table schema
export const TASK_RUN_COLUMNS = [
  "environment_id",
  "organization_id",
  "project_id",
  "run_id",
  "updated_at",
  "created_at",
  "status",
  "environment_type",
  "friendly_id",
  "attempt",
  "engine",
  "task_identifier",
  "queue",
  "schedule_id",
  "batch_id",
  "completed_at",
  "started_at",
  "executed_at",
  "delay_until",
  "queued_at",
  "expired_at",
  "usage_duration_ms",
  "cost_in_cents",
  "base_cost_in_cents",
  "output",
  "error",
  "tags",
  "task_version",
  "sdk_version",
  "cli_version",
  "machine_preset",
  "root_run_id",
  "parent_run_id",
  "depth",
  "span_id",
  "trace_id",
  "idempotency_key",
  "expiration_ttl",
  "is_test",
  "_version",
  "_is_deleted",
  "concurrency_key",
  "bulk_action_group_ids",
  "worker_queue",
  "max_duration_in_seconds",
] as const;

// Type-safe column indices derived from TASK_RUN_COLUMNS
// This ensures indices stay in sync with column order
export const TASK_RUN_INDEX = {
  environment_id: 0,
  organization_id: 1,
  project_id: 2,
  run_id: 3,
  updated_at: 4,
  created_at: 5,
  status: 6,
  environment_type: 7,
  friendly_id: 8,
  attempt: 9,
  engine: 10,
  task_identifier: 11,
  queue: 12,
  schedule_id: 13,
  batch_id: 14,
  completed_at: 15,
  started_at: 16,
  executed_at: 17,
  delay_until: 18,
  queued_at: 19,
  expired_at: 20,
  usage_duration_ms: 21,
  cost_in_cents: 22,
  base_cost_in_cents: 23,
  output: 24,
  error: 25,
  tags: 26,
  task_version: 27,
  sdk_version: 28,
  cli_version: 29,
  machine_preset: 30,
  root_run_id: 31,
  parent_run_id: 32,
  depth: 33,
  span_id: 34,
  trace_id: 35,
  idempotency_key: 36,
  expiration_ttl: 37,
  is_test: 38,
  _version: 39,
  _is_deleted: 40,
  concurrency_key: 41,
  bulk_action_group_ids: 42,
  worker_queue: 43,
  max_duration_in_seconds: 44,
} as const satisfies Record<(typeof TASK_RUN_COLUMNS)[number], number>;

export type TaskRunColumnName = (typeof TASK_RUN_COLUMNS)[number];

// Runtime assertion to verify TASK_RUN_INDEX matches TASK_RUN_COLUMNS order
// This will throw at module load time if there's a mismatch
(function verifyTaskRunColumnIndices() {
  for (let i = 0; i < TASK_RUN_COLUMNS.length; i++) {
    const column = TASK_RUN_COLUMNS[i];
    const index = TASK_RUN_INDEX[column];
    if (index !== i) {
      throw new Error(
        `TASK_RUN_INDEX mismatch: column "${column}" has index ${index} but should be ${i}`
      );
    }
  }
})();

export function insertTaskRunsCompactArrays(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insertCompactRaw({
    name: "insertTaskRunsCompactArrays",
    table: "trigger_dev.task_runs_v2",
    columns: TASK_RUN_COLUMNS,
    settings: {
      enable_json_type: 1,
      type_json_skip_duplicated_paths: 1,
      ...settings,
    },
  });
}

export const RawTaskRunPayloadV1 = z.object({
  run_id: z.string(),
  created_at: z.number().int(),
  payload: z.unknown(),
});

export type RawTaskRunPayloadV1 = z.infer<typeof RawTaskRunPayloadV1>;

export const PAYLOAD_COLUMNS = ["run_id", "created_at", "payload"] as const;

// Type-safe column indices for payload columns
export const PAYLOAD_INDEX = {
  run_id: 0,
  created_at: 1,
  payload: 2,
} as const satisfies Record<(typeof PAYLOAD_COLUMNS)[number], number>;

export type PayloadColumnName = (typeof PAYLOAD_COLUMNS)[number];

/**
 * Type-safe tuple representing a task run insert array.
 * Order matches TASK_RUN_COLUMNS exactly.
 */
export type TaskRunInsertArray = [
  environment_id: string,
  organization_id: string,
  project_id: string,
  run_id: string,
  updated_at: number,
  created_at: number,
  status: string,
  environment_type: string,
  friendly_id: string,
  attempt: number,
  engine: string,
  task_identifier: string,
  queue: string,
  schedule_id: string,
  batch_id: string,
  completed_at: number | null,
  started_at: number | null,
  executed_at: number | null,
  delay_until: number | null,
  queued_at: number | null,
  expired_at: number | null,
  usage_duration_ms: number,
  cost_in_cents: number,
  base_cost_in_cents: number,
  output: { data: unknown },
  error: { data: unknown },
  tags: string[],
  task_version: string,
  sdk_version: string,
  cli_version: string,
  machine_preset: string,
  root_run_id: string,
  parent_run_id: string,
  depth: number,
  span_id: string,
  trace_id: string,
  idempotency_key: string,
  expiration_ttl: string,
  is_test: boolean,
  _version: string,
  _is_deleted: number,
  concurrency_key: string,
  bulk_action_group_ids: string[],
  worker_queue: string,
  max_duration_in_seconds: number | null,
];

/**
 * Type-safe tuple representing a payload insert array.
 * Order matches PAYLOAD_COLUMNS exactly.
 */
export type PayloadInsertArray = [
  run_id: string,
  created_at: number,
  payload: { data: unknown },
];

export function insertRawTaskRunPayloadsCompactArrays(
  ch: ClickhouseWriter,
  settings?: ClickHouseSettings
) {
  return ch.insertCompactRaw({
    name: "insertRawTaskRunPayloadsCompactArrays",
    table: "trigger_dev.raw_task_runs_payload_v1",
    columns: PAYLOAD_COLUMNS,
    settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
      async_insert_max_data_size: "1000000",
      async_insert_busy_timeout_ms: 1000,
      enable_json_type: 1,
      type_json_skip_duplicated_paths: 1,
      ...settings,
    },
  });
}

export const TaskRunV2QueryResult = z.object({
  run_id: z.string(),
});

export type TaskRunV2QueryResult = z.infer<typeof TaskRunV2QueryResult>;

export function getTaskRunsQueryBuilder(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilder({
    name: "getTaskRuns",
    baseQuery: "SELECT run_id FROM trigger_dev.task_runs_v2 FINAL",
    schema: TaskRunV2QueryResult,
    settings,
  });
}

export function getTaskRunsCountQueryBuilder(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilder({
    name: "getTaskRunsCount",
    baseQuery: "SELECT count() as count FROM trigger_dev.task_runs_v2 FINAL",
    schema: z.object({
      count: z.number().int(),
    }),
    settings,
  });
}

export const TaskRunTagsQueryResult = z.object({
  tag: z.string(),
});

export type TaskRunTagsQueryResult = z.infer<typeof TaskRunTagsQueryResult>;

export function getTaskRunTagsQueryBuilder(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilder({
    name: "getTaskRunTags",
    baseQuery: "SELECT DISTINCT arrayJoin(tags) as tag FROM trigger_dev.task_runs_v2",
    schema: TaskRunTagsQueryResult,
    settings,
  });
}

export const TaskActivityQueryResult = z.object({
  task_identifier: z.string(),
  status: z.string(),
  day: z.string(),
  count: z.number().int(),
});

export type TaskActivityQueryResult = z.infer<typeof TaskActivityQueryResult>;

export const TaskActivityQueryParams = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  days: z.number().int(),
});

export function getTaskActivityQueryBuilder(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.query({
    name: "getTaskActivity",
    query: `
      SELECT
          task_identifier,
          status,
          toDate(created_at) as day,
          count() as count
      FROM trigger_dev.task_runs_v2 FINAL
      WHERE
          organization_id = {organizationId: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND created_at >= today() - {days: Int64}
          AND _is_deleted = 0
      GROUP BY
          task_identifier,
          status,
          day
      ORDER BY
          task_identifier ASC,
          day ASC,
          status ASC
    `,
    schema: TaskActivityQueryResult,
    params: TaskActivityQueryParams,
    settings,
  });
}

export const CurrentRunningStatsQueryResult = z.object({
  task_identifier: z.string(),
  status: z.string(),
  count: z.number().int(),
});

export type CurrentRunningStatsQueryResult = z.infer<typeof CurrentRunningStatsQueryResult>;

export const CurrentRunningStatsQueryParams = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  days: z.number().int(),
});

export function getCurrentRunningStats(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.query({
    name: "getCurrentRunningStats",
    query: `
    SELECT
        task_identifier,
        status,
        count() as count
    FROM trigger_dev.task_runs_v2 FINAL
    WHERE
        organization_id = {organizationId: String}
        AND project_id = {projectId: String}
        AND environment_id = {environmentId: String}
        AND status IN ('PENDING', 'WAITING_FOR_DEPLOY', 'WAITING_TO_RESUME', 'QUEUED', 'EXECUTING', 'DELAYED')
        AND _is_deleted = 0
        AND created_at >= now() - INTERVAL {days: Int64} DAY
    GROUP BY
        task_identifier,
        status
    ORDER BY
        task_identifier ASC
    `,
    schema: CurrentRunningStatsQueryResult,
    params: CurrentRunningStatsQueryParams,
    settings,
  });
}

export const AverageDurationsQueryResult = z.object({
  task_identifier: z.string(),
  duration: z.number(),
});

export type AverageDurationsQueryResult = z.infer<typeof AverageDurationsQueryResult>;

export const AverageDurationsQueryParams = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  days: z.number().int(),
});

export function getAverageDurations(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.query({
    name: "getAverageDurations",
    query: `
    SELECT
        task_identifier,
        avg(toUnixTimestamp(completed_at) - toUnixTimestamp(started_at)) as duration
    FROM trigger_dev.task_runs_v2 FINAL
    WHERE
        organization_id = {organizationId: String}
        AND project_id = {projectId: String}
        AND environment_id = {environmentId: String}
        AND created_at >= today() - {days: Int64}
        AND status IN ('COMPLETED_SUCCESSFULLY', 'COMPLETED_WITH_ERRORS')
        AND started_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND _is_deleted = 0
    GROUP BY
        task_identifier
    `,
    schema: AverageDurationsQueryResult,
    params: AverageDurationsQueryParams,
    settings,
  });
}

export const TaskUsageByOrganizationQueryResult = z.object({
  task_identifier: z.string(),
  run_count: z.number(),
  average_duration: z.number(),
  total_duration: z.number(),
  average_cost: z.number(),
  total_cost: z.number(),
  total_base_cost: z.number(),
});

export const TaskUsageByOrganizationQueryParams = z.object({
  startTime: z.number().int(),
  endTime: z.number().int(),
  organizationId: z.string(),
});

export function getTaskUsageByOrganization(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.query({
    name: "getTaskUsageByOrganization",
    query: `
      SELECT
      task_identifier,
      count() AS run_count,
      avg(usage_duration_ms) AS average_duration,
      sum(usage_duration_ms) AS total_duration,
      avg(cost_in_cents) / 100.0 AS average_cost,
      sum(cost_in_cents) / 100.0 AS total_cost,
      sum(base_cost_in_cents) / 100.0 AS total_base_cost
  FROM trigger_dev.task_runs_v2 FINAL
  WHERE
      environment_type != 'DEVELOPMENT'
      AND created_at >= fromUnixTimestamp64Milli({startTime: Int64})
      AND created_at < fromUnixTimestamp64Milli({endTime: Int64})
      AND organization_id = {organizationId: String}
      AND _is_deleted = 0
  GROUP BY
      task_identifier
  ORDER BY
      total_cost DESC
    `,
    schema: TaskUsageByOrganizationQueryResult,
    params: TaskUsageByOrganizationQueryParams,
    settings,
  });
}
