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
