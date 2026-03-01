import { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import { ClickhouseReader } from "./client/types.js";

export const ErrorGroupsListQueryResult = z.object({
  error_fingerprint: z.string(),
  error_type: z.string(),
  error_message: z.string(),
  first_seen: z.string(),
  last_seen: z.string(),
  occurrence_count: z.number(),
  affected_tasks: z.number(),
  sample_run_id: z.string(),
  sample_friendly_id: z.string(),
  sample_task_identifier: z.string(),
});

export type ErrorGroupsListQueryResult = z.infer<typeof ErrorGroupsListQueryResult>;

/**
 * Gets a query builder for listing error groups from the pre-aggregated errors_v1 table.
 * Allows flexible filtering and pagination.
 */
export function getErrorGroupsListQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilder({
    name: "getErrorGroupsList",
    baseQuery: `
      SELECT
        error_fingerprint,
        any(error_type) as error_type,
        any(error_message) as error_message,
        toString(minMerge(first_seen)) as first_seen,
        toString(maxMerge(last_seen)) as last_seen,
        toUInt64(sumMerge(occurrence_count)) as occurrence_count,
        toUInt64(uniqMerge(affected_tasks)) as affected_tasks,
        anyMerge(sample_run_id) as sample_run_id,
        anyMerge(sample_friendly_id) as sample_friendly_id,
        anyMerge(sample_task_identifier) as sample_task_identifier
      FROM trigger_dev.errors_v1
    `,
    schema: ErrorGroupsListQueryResult,
    settings,
  });
}

export const ErrorGroupQueryResult = z.object({
  error_fingerprint: z.string(),
  error_type: z.string(),
  error_message: z.string(),
  first_seen: z.string(),
  last_seen: z.string(),
  occurrence_count: z.number(),
  affected_tasks: z.number(),
  sample_run_id: z.string(),
  sample_friendly_id: z.string(),
  sample_task_identifier: z.string(),
});

export type ErrorGroupQueryResult = z.infer<typeof ErrorGroupQueryResult>;

export const ErrorGroupQueryParams = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  days: z.number().int().default(30),
  limit: z.number().int().default(50),
  offset: z.number().int().default(0),
});

export type ErrorGroupQueryParams = z.infer<typeof ErrorGroupQueryParams>;

/**
 * Gets error groups from the pre-aggregated errors_v1 table.
 * Much faster than on-the-fly aggregation.
 */
export function getErrorGroups(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.query({
    name: "getErrorGroups",
    query: `
      SELECT
        error_fingerprint,
        any(error_type) as error_type,
        any(error_message) as error_message,
        toString(minMerge(first_seen)) as first_seen,
        toString(maxMerge(last_seen)) as last_seen,
        toUInt64(sumMerge(occurrence_count)) as occurrence_count,
        toUInt64(uniqMerge(affected_tasks)) as affected_tasks,
        anyMerge(sample_run_id) as sample_run_id,
        anyMerge(sample_friendly_id) as sample_friendly_id,
        anyMerge(sample_task_identifier) as sample_task_identifier
      FROM trigger_dev.errors_v1
      WHERE
        organization_id = {organizationId: String}
        AND project_id = {projectId: String}
        AND environment_id = {environmentId: String}
        AND maxMerge(last_seen) >= now() - INTERVAL {days: Int64} DAY
      GROUP BY error_fingerprint
      ORDER BY last_seen DESC
      LIMIT {limit: Int64}
      OFFSET {offset: Int64}
    `,
    schema: ErrorGroupQueryResult,
    params: ErrorGroupQueryParams,
    settings,
  });
}

export const ErrorInstanceQueryResult = z.object({
  run_id: z.string(),
  friendly_id: z.string(),
  task_identifier: z.string(),
  created_at: z.string(),
  status: z.string(),
  error_text: z.string(),
  trace_id: z.string(),
  task_version: z.string(),
});

export type ErrorInstanceQueryResult = z.infer<typeof ErrorInstanceQueryResult>;

export const ErrorInstanceQueryParams = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  errorFingerprint: z.string(),
  limit: z.number().int().default(50),
  offset: z.number().int().default(0),
});

export type ErrorInstanceQueryParams = z.infer<typeof ErrorInstanceQueryParams>;

export const ErrorInstancesListQueryResult = z.object({
  run_id: z.string(),
  friendly_id: z.string(),
  task_identifier: z.string(),
  created_at: z.string(),
  status: z.string(),
  error_text: z.string(),
  trace_id: z.string(),
  task_version: z.string(),
});

export type ErrorInstancesListQueryResult = z.infer<typeof ErrorInstancesListQueryResult>;

/**
 * Gets a query builder for listing error instances from task_runs_v2.
 * Allows flexible filtering and pagination for runs with a specific error fingerprint.
 */
export function getErrorInstancesListQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilder({
    name: "getErrorInstancesList",
    baseQuery: `
      SELECT
        run_id,
        friendly_id,
        task_identifier,
        toString(created_at) as created_at,
        status,
        error_text,
        trace_id,
        task_version
      FROM trigger_dev.task_runs_v2 FINAL
    `,
    schema: ErrorInstancesListQueryResult,
    settings,
  });
}

/**
 * Gets individual run instances for a specific error fingerprint.
 */
export function getErrorInstances(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.query({
    name: "getErrorInstances",
    query: `
      SELECT
        run_id,
        friendly_id,
        task_identifier,
        toString(created_at) as created_at,
        status,
        error_text,
        trace_id,
        task_version
      FROM trigger_dev.task_runs_v2 FINAL
      WHERE
        organization_id = {organizationId: String}
        AND project_id = {projectId: String}
        AND environment_id = {environmentId: String}
        AND error_fingerprint = {errorFingerprint: String}
        AND _is_deleted = 0
      ORDER BY created_at DESC
      LIMIT {limit: Int64}
      OFFSET {offset: Int64}
    `,
    schema: ErrorInstanceQueryResult,
    params: ErrorInstanceQueryParams,
    settings,
  });
}
