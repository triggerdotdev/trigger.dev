import { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import { ClickhouseReader } from "./client/types.js";
import { ClickhouseQueryBuilder } from "./client/queryBuilder.js";

export const ErrorGroupsListQueryResult = z.object({
  error_fingerprint: z.string(),
  task_identifier: z.string(),
  error_type: z.string(),
  error_message: z.string(),
  first_seen: z.string(),
  last_seen: z.string(),
  occurrence_count: z.number(),
  sample_run_id: z.string(),
  sample_friendly_id: z.string(),
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
        task_identifier,
        any(error_type) as error_type,
        any(error_message) as error_message,
        toString(toUnixTimestamp64Milli(min(first_seen))) as first_seen,
        toString(toUnixTimestamp64Milli(max(last_seen))) as last_seen,
        toUInt64(sumMerge(occurrence_count)) as occurrence_count,
        anyMerge(sample_run_id) as sample_run_id,
        anyMerge(sample_friendly_id) as sample_friendly_id
      FROM trigger_dev.errors_v1
    `,
    schema: ErrorGroupsListQueryResult,
    settings,
  });
}

export const ErrorGroupQueryResult = z.object({
  error_fingerprint: z.string(),
  task_identifier: z.string(),
  error_type: z.string(),
  error_message: z.string(),
  first_seen: z.string(),
  last_seen: z.string(),
  occurrence_count: z.number(),
  sample_run_id: z.string(),
  sample_friendly_id: z.string(),
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
        task_identifier,
        any(error_type) as error_type,
        any(error_message) as error_message,
        toString(toUnixTimestamp64Milli(min(first_seen))) as first_seen,
        toString(toUnixTimestamp64Milli(max(last_seen))) as last_seen,
        toUInt64(sumMerge(occurrence_count)) as occurrence_count,
        anyMerge(sample_run_id) as sample_run_id,
        anyMerge(sample_friendly_id) as sample_friendly_id
      FROM trigger_dev.errors_v1
      WHERE
        organization_id = {organizationId: String}
        AND project_id = {projectId: String}
        AND environment_id = {environmentId: String}
      GROUP BY error_fingerprint, task_identifier
      HAVING toInt64(last_seen) >= toInt64(toUnixTimestamp(now() - INTERVAL {days: Int64} DAY)) * 1000
      ORDER BY toInt64(last_seen) DESC
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

export const ErrorHourlyOccurrencesQueryResult = z.object({
  error_fingerprint: z.string(),
  hour_epoch: z.number(),
  count: z.number(),
});

export type ErrorHourlyOccurrencesQueryResult = z.infer<typeof ErrorHourlyOccurrencesQueryResult>;

export const ErrorHourlyOccurrencesQueryParams = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  fingerprints: z.array(z.string()),
  hours: z.number().int().default(24),
});

export type ErrorHourlyOccurrencesQueryParams = z.infer<typeof ErrorHourlyOccurrencesQueryParams>;

/**
 * Gets hourly occurrence counts for specific error fingerprints over the past N hours.
 * Queries task_runs_v2 directly, grouped by fingerprint and hour.
 */
export function getErrorHourlyOccurrences(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.query({
    name: "getErrorHourlyOccurrences",
    query: `
      SELECT
        error_fingerprint,
        toUnixTimestamp(toStartOfHour(created_at)) as hour_epoch,
        count() as count
      FROM trigger_dev.task_runs_v2 FINAL
      WHERE
        organization_id = {organizationId: String}
        AND project_id = {projectId: String}
        AND environment_id = {environmentId: String}
        AND created_at >= now() - INTERVAL {hours: Int64} HOUR
        AND error_fingerprint IN {fingerprints: Array(String)}
        AND status IN ('SYSTEM_FAILURE', 'CRASHED', 'INTERRUPTED', 'COMPLETED_WITH_ERRORS', 'TIMED_OUT')
        AND _is_deleted = 0
      GROUP BY
        error_fingerprint,
        hour_epoch
      ORDER BY
        error_fingerprint ASC,
        hour_epoch ASC
    `,
    schema: ErrorHourlyOccurrencesQueryResult,
    params: ErrorHourlyOccurrencesQueryParams,
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

// ---------------------------------------------------------------------------
// Affected versions – distinct task_version from error_occurrences_v1
// ---------------------------------------------------------------------------

export const ErrorAffectedVersionsQueryResult = z.object({
  task_version: z.string(),
});

export type ErrorAffectedVersionsQueryResult = z.infer<typeof ErrorAffectedVersionsQueryResult>;

/**
 * Query builder for fetching distinct task_version values for an error fingerprint
 * from the error_occurrences_v1 SummingMergeTree table.
 * task_version is part of the ORDER BY key, so this is efficient.
 */
export function getErrorAffectedVersionsQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilder({
    name: "getErrorAffectedVersions",
    baseQuery: `
      SELECT DISTINCT task_version
      FROM trigger_dev.error_occurrences_v1
    `,
    schema: ErrorAffectedVersionsQueryResult,
    settings,
  });
}

// ---------------------------------------------------------------------------
// error_occurrences_v1 – per-minute bucketed error counts
// ---------------------------------------------------------------------------

export const ErrorOccurrencesListQueryResult = z.object({
  error_fingerprint: z.string(),
  task_identifier: z.string(),
  error_type: z.string(),
  error_message: z.string(),
  occurrence_count: z.number(),
});

export type ErrorOccurrencesListQueryResult = z.infer<typeof ErrorOccurrencesListQueryResult>;

/**
 * Query builder for listing error groups from the per-minute error_occurrences_v1 table.
 * Time filtering is done via WHERE on the `minute` column, giving precise time-scoped counts.
 */
export function getErrorOccurrencesListQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilder({
    name: "getErrorOccurrencesList",
    baseQuery: `
      SELECT
        error_fingerprint,
        task_identifier,
        any(error_type) as error_type,
        any(error_message) as error_message,
        sum(count) as occurrence_count
      FROM trigger_dev.error_occurrences_v1
    `,
    schema: ErrorOccurrencesListQueryResult,
    settings,
  });
}

export const ErrorOccurrencesBucketQueryResult = z.object({
  error_fingerprint: z.string(),
  bucket_epoch: z.number(),
  count: z.number(),
});

export type ErrorOccurrencesBucketQueryResult = z.infer<typeof ErrorOccurrencesBucketQueryResult>;

/**
 * Creates a query builder for bucketed error occurrence counts.
 * The `intervalExpr` is a ClickHouse INTERVAL literal (e.g. "INTERVAL 1 HOUR").
 * Returns a builder directly since the base query varies with each granularity.
 */
export function createErrorOccurrencesQueryBuilder(
  ch: ClickhouseReader,
  intervalExpr: string,
  settings?: ClickHouseSettings
): ClickhouseQueryBuilder<ErrorOccurrencesBucketQueryResult> {
  return new ClickhouseQueryBuilder(
    "getErrorOccurrencesBucketed",
    `
      SELECT
        error_fingerprint,
        toUnixTimestamp(toStartOfInterval(minute, ${intervalExpr})) as bucket_epoch,
        sum(count) as count
      FROM trigger_dev.error_occurrences_v1
    `,
    ch,
    ErrorOccurrencesBucketQueryResult,
    settings
  );
}

export const ErrorOccurrencesByVersionQueryResult = z.object({
  error_fingerprint: z.string(),
  task_version: z.string(),
  bucket_epoch: z.number(),
  count: z.number(),
});

export type ErrorOccurrencesByVersionQueryResult = z.infer<
  typeof ErrorOccurrencesByVersionQueryResult
>;

/**
 * Creates a query builder for bucketed error occurrence counts grouped by task_version.
 * Used for stacked-by-version activity charts on the error detail page.
 */
export function createErrorOccurrencesByVersionQueryBuilder(
  ch: ClickhouseReader,
  intervalExpr: string,
  settings?: ClickHouseSettings
): ClickhouseQueryBuilder<ErrorOccurrencesByVersionQueryResult> {
  return new ClickhouseQueryBuilder(
    "getErrorOccurrencesByVersion",
    `
      SELECT
        error_fingerprint,
        task_version,
        toUnixTimestamp(toStartOfInterval(minute, ${intervalExpr})) as bucket_epoch,
        sum(count) as count
      FROM trigger_dev.error_occurrences_v1
    `,
    ch,
    ErrorOccurrencesByVersionQueryResult,
    settings
  );
}

// ---------------------------------------------------------------------------
// Alert evaluator – active errors since a timestamp
// ---------------------------------------------------------------------------

export const ActiveErrorsSinceQueryResult = z.object({
  environment_id: z.string(),
  task_identifier: z.string(),
  error_fingerprint: z.string(),
  error_type: z.string(),
  error_message: z.string(),
  sample_stack_trace: z.string(),
  first_seen: z.string(),
  last_seen: z.string(),
  occurrence_count: z.number(),
});

export type ActiveErrorsSinceQueryResult = z.infer<typeof ActiveErrorsSinceQueryResult>;

/**
 * Query builder for fetching all errors active since a given timestamp.
 * Returns errors with last_seen > scheduledAt, grouped by env/task/fingerprint.
 * Used by the error alert evaluator to find new issues, regressions, and un-ignored errors.
 */
export function getActiveErrorsSinceQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilder({
    name: "getActiveErrorsSince",
    baseQuery: `
      SELECT
        environment_id,
        task_identifier,
        error_fingerprint,
        any(error_type) as error_type,
        any(error_message) as error_message,
        any(sample_stack_trace) as sample_stack_trace,
        toString(toUnixTimestamp64Milli(min(first_seen))) as first_seen,
        toString(toUnixTimestamp64Milli(max(last_seen))) as last_seen,
        toUInt64(sumMerge(occurrence_count)) as occurrence_count
      FROM trigger_dev.errors_v1
    `,
    schema: ActiveErrorsSinceQueryResult,
    settings,
  });
}

export const OccurrenceCountsSinceQueryResult = z.object({
  environment_id: z.string(),
  task_identifier: z.string(),
  error_fingerprint: z.string(),
  occurrences_since: z.number(),
});

export type OccurrenceCountsSinceQueryResult = z.infer<typeof OccurrenceCountsSinceQueryResult>;

/**
 * Query builder for occurrence counts since a given timestamp, grouped by error.
 * Used by the alert evaluator to check ignore thresholds.
 */
export function getOccurrenceCountsSinceQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilder({
    name: "getOccurrenceCountsSince",
    baseQuery: `
      SELECT
        environment_id,
        task_identifier,
        error_fingerprint,
        sum(count) as occurrences_since
      FROM trigger_dev.error_occurrences_v1
    `,
    schema: OccurrenceCountsSinceQueryResult,
    settings,
  });
}

// ---------------------------------------------------------------------------
// Alert evaluator helpers – occurrence rate & count since timestamp
// ---------------------------------------------------------------------------

export const ErrorOccurrenceTotalCountResult = z.object({
  total_count: z.number(),
});

export type ErrorOccurrenceTotalCountResult = z.infer<typeof ErrorOccurrenceTotalCountResult>;

/**
 * Query builder for summing occurrences since a given timestamp.
 * Used by the alert evaluator to check total-count-based ignore thresholds.
 */
export function getOccurrenceCountSinceQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilder({
    name: "getOccurrenceCountSince",
    baseQuery: `
      SELECT
        sum(count) as total_count
      FROM trigger_dev.error_occurrences_v1
    `,
    schema: ErrorOccurrenceTotalCountResult,
    settings,
  });
}
