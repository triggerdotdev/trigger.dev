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

export function insertTaskRuns(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insert({
    name: "insertTaskRuns",
    table: "trigger_dev.task_runs_v2",
    schema: TaskRunV2,
    settings: {
      enable_json_type: 1,
      type_json_skip_duplicated_paths: 1,
      ...settings,
    },
  });
}

export function insertTaskRunsUnsafe(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insertUnsafe({
    name: "insertTaskRunsUnsafe",
    table: "trigger_dev.task_runs_v2",
    settings: {
      enable_json_type: 1,
      type_json_skip_duplicated_paths: 1,
      ...settings,
    },
  });
}

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
  "concurrency_key",
  "bulk_action_group_ids",
  "worker_queue",
  "max_duration_in_seconds",
  "_version",
  "_is_deleted",
] as const;

function taskRunToArray(run: TaskRunV2): any[] {
  return [
    run.environment_id,
    run.organization_id,
    run.project_id,
    run.run_id,
    run.updated_at,
    run.created_at,
    run.status,
    run.environment_type,
    run.friendly_id,
    run.attempt ?? 1,
    run.engine,
    run.task_identifier,
    run.queue,
    run.schedule_id,
    run.batch_id,
    run.completed_at ?? null,
    run.started_at ?? null,
    run.executed_at ?? null,
    run.delay_until ?? null,
    run.queued_at ?? null,
    run.expired_at ?? null,
    run.usage_duration_ms ?? 0,
    run.cost_in_cents ?? 0,
    run.base_cost_in_cents ?? 0,
    run.output,
    run.error,
    run.tags ?? [],
    run.task_version,
    run.sdk_version,
    run.cli_version,
    run.machine_preset,
    run.root_run_id,
    run.parent_run_id,
    run.depth ?? 0,
    run.span_id,
    run.trace_id,
    run.idempotency_key,
    run.expiration_ttl,
    run.is_test ?? false,
    run.concurrency_key ?? "",
    run.bulk_action_group_ids ?? [],
    run.worker_queue ?? "",
    run._version,
    run._is_deleted ?? 0,
  ];
}

export function insertTaskRunsCompact(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insertCompact({
    name: "insertTaskRunsCompact",
    table: "trigger_dev.task_runs_v2",
    columns: TASK_RUN_COLUMNS as any,
    toArray: taskRunToArray,
    settings: {
      enable_json_type: 1,
      type_json_skip_duplicated_paths: 1,
      ...settings,
    },
  });
}

export function insertTaskRunsCompactArrays(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insertCompact({
    name: "insertTaskRunsCompactArrays",
    table: "trigger_dev.task_runs_v2",
    columns: TASK_RUN_COLUMNS as any,
    toArray: (arr: any[]) => arr, // Identity function - data is already an array
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

export function insertRawTaskRunPayloads(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insert({
    name: "insertRawTaskRunPayloads",
    table: "trigger_dev.raw_task_runs_payload_v1",
    schema: RawTaskRunPayloadV1,
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

export function insertRawTaskRunPayloadsUnsafe(
  ch: ClickhouseWriter,
  settings?: ClickHouseSettings
) {
  return ch.insertUnsafe({
    name: "insertRawTaskRunPayloadsUnsafe",
    table: "trigger_dev.raw_task_runs_payload_v1",
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

export const PAYLOAD_COLUMNS = ["run_id", "created_at", "payload"] as const;

function payloadToArray(payload: RawTaskRunPayloadV1): any[] {
  return [payload.run_id, payload.created_at, payload.payload];
}

export function insertRawTaskRunPayloadsCompact(
  ch: ClickhouseWriter,
  settings?: ClickHouseSettings
) {
  return ch.insertCompact({
    name: "insertRawTaskRunPayloadsCompact",
    table: "trigger_dev.raw_task_runs_payload_v1",
    columns: PAYLOAD_COLUMNS,
    toArray: payloadToArray,
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

export function insertRawTaskRunPayloadsCompactArrays(
  ch: ClickhouseWriter,
  settings?: ClickHouseSettings
) {
  return ch.insertCompact({
    name: "insertRawTaskRunPayloadsCompactArrays",
    table: "trigger_dev.raw_task_runs_payload_v1",
    columns: PAYLOAD_COLUMNS,
    toArray: (arr: any[]) => arr, // Identity function - data is already an array
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
