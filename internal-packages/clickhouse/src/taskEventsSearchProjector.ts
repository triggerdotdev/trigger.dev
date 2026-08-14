import type { ClickHouseSettings, CommandResult } from "@clickhouse/client";
import type { Result } from "@trigger.dev/core/v3";
import { z } from "zod";
import type { QueryError } from "./client/errors.js";
import type { ClickhouseWriter } from "./client/types.js";

export type TaskEventsSearchV2ProjectionWindow = {
  start: Date;
  end: Date;
};

export type TaskEventsSearchV2ProjectionLimits = {
  maxExecutionTimeSeconds: number;
  maxRowsToRead: number;
  maxMemoryUsage: number;
  maxThreads: number;
};

const ProjectionParams = z
  .object({
    windowStart: z.string(),
    windowEnd: z.string(),
  })
  .refine(({ windowStart, windowEnd }) => windowStart < windowEnd, {
    message: "windowStart must be before windowEnd",
  });

const projectedColumns = `
  environment_id,
  organization_id,
  project_id,
  triggered_timestamp,
  trace_id,
  span_id,
  run_id,
  task_identifier,
  start_time,
  inserted_at,
  message,
  error_message,
  search_text,
  kind,
  status,
  duration,
  parent_span_id`;

const projectionFingerprint = (alias: string) => `reinterpretAsUInt128(sipHash128(
  ${alias}.trace_id,
  ${alias}.span_id,
  ${alias}.run_id,
  ${alias}.start_time
))`;

const projectionSql = `
INSERT INTO trigger_dev.task_events_search_v2
(${projectedColumns}, projection_fingerprint)
SELECT${projectedColumns},
  ${projectionFingerprint("candidate")} AS projection_fingerprint
FROM
(
  SELECT
    environment_id,
    organization_id,
    project_id,
    least(
      fromUnixTimestamp64Nano(toUnixTimestamp64Nano(start_time) + toInt64(duration)),
      {windowEnd: DateTime64(3, 'UTC')} + INTERVAL 5 MINUTE
    ) AS triggered_timestamp,
    trace_id,
    span_id,
    run_id,
    task_identifier,
    start_time,
    inserted_at,
    message,
    substring(JSONExtractString(attributes_text, 'error', 'message'), 1, 2048) AS error_message,
    replaceRegexpAll(
      lowerUTF8(
        substring(
          concat(
            substring(message, 1, 2048),
            ' ',
            replaceAll(substring(attributes_text, 1, 6144), '\\\\/', '/')
          ),
          1,
          8192
        )
      ),
      '[^\\\\p{L}\\\\p{N}_./:@+-]+',
      ' '
    ) AS search_text,
    kind,
    status,
    duration,
    parent_span_id
  FROM trigger_dev.task_events_v2
  WHERE
    inserted_at >= {windowStart: DateTime64(3, 'UTC')}
    AND inserted_at < {windowEnd: DateTime64(3, 'UTC')}
    AND trace_id != ''
    AND kind != 'DEBUG_EVENT'
    AND status != 'PARTIAL'
    AND NOT (kind = 'SPAN_EVENT' AND attributes_text = '{}')
    AND kind != 'ANCESTOR_OVERRIDE'
    AND message != 'trigger.dev/start'
) AS candidate
ORDER BY
  organization_id,
  environment_id,
  triggered_timestamp,
  trace_id,
  span_id,
  projection_fingerprint
`;

export function projectTaskEventsSearchV2Window(writer: ClickhouseWriter) {
  return async (
    window: TaskEventsSearchV2ProjectionWindow,
    limits: TaskEventsSearchV2ProjectionLimits
  ): Promise<Result<CommandResult, QueryError>> => {
    assertProjectionWindow(window);
    const command = writer.command({
      name: "project-task-events-search-v2-window",
      query: projectionSql,
      params: ProjectionParams,
    });
    const settings: ClickHouseSettings = {
      async_insert: 0,
      max_execution_time: limits.maxExecutionTimeSeconds,
      max_rows_to_read: limits.maxRowsToRead.toString(),
      max_memory_usage: limits.maxMemoryUsage.toString(),
      max_threads: limits.maxThreads,
      max_insert_threads: limits.maxThreads.toString(),
      use_query_condition_cache: 0,
    };

    return command(
      {
        windowStart: toClickHouseDateTime64(window.start),
        windowEnd: toClickHouseDateTime64(window.end),
      },
      {
        attributes: {
          windowStart: window.start.toISOString(),
          windowEnd: window.end.toISOString(),
        },
        params: { clickhouse_settings: settings },
      }
    );
  };
}

function assertProjectionWindow(window: TaskEventsSearchV2ProjectionWindow) {
  if (
    !Number.isFinite(window.start.getTime()) ||
    !Number.isFinite(window.end.getTime()) ||
    window.start >= window.end
  ) {
    throw new Error("Invalid task events search projection window");
  }
}

function toClickHouseDateTime64(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}
