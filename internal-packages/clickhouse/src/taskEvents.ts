import { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import { ClickhouseReader, ClickhouseWriter } from "./client/types.js";

export const TaskEventV1Input = z.object({
  environment_id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  task_identifier: z.string(),
  run_id: z.string(),
  start_time: z.string(),
  duration: z.string(),
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string(),
  message: z.string(),
  kind: z.string(),
  status: z.string(),
  attributes: z.unknown(),
  metadata: z.string(),
  expires_at: z.string(),
});

export type TaskEventV1Input = z.input<typeof TaskEventV1Input>;

export function insertTaskEvents(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insertUnsafe<TaskEventV1Input>({
    name: "insertTaskEvents",
    table: "trigger_dev.task_events_v1",
    settings: {
      enable_json_type: 1,
      type_json_skip_duplicated_paths: 1,
      input_format_json_throw_on_bad_escape_sequence: 0,
      input_format_json_use_string_type_for_ambiguous_paths_in_named_tuples_inference_from_objects: 1,
      ...settings,
    },
  });
}

export const TaskEventSummaryV1Result = z.object({
  span_id: z.string(),
  parent_span_id: z.string(),
  run_id: z.string(),
  start_time: z.string(),
  duration: z.number().or(z.string()),
  status: z.string(),
  kind: z.string(),
  metadata: z.string(),
  message: z.string(),
});

export type TaskEventSummaryV1Result = z.output<typeof TaskEventSummaryV1Result>;

export function getTraceSummaryQueryBuilder(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilderFast<TaskEventSummaryV1Result>({
    name: "getTraceEvents",
    table: "trigger_dev.task_events_v1",
    columns: [
      "span_id",
      "parent_span_id",
      "run_id",
      "start_time",
      "duration",
      "status",
      "kind",
      "metadata",
      { name: "message", expression: "LEFT(message, 256)" },
    ],
    settings,
  });
}

export const TaskEventDetailedSummaryV1Result = z.object({
  span_id: z.string(),
  parent_span_id: z.string(),
  run_id: z.string(),
  start_time: z.string(),
  duration: z.number().or(z.string()),
  status: z.string(),
  kind: z.string(),
  metadata: z.string(),
  message: z.string(),
  attributes_text: z.string(),
});

export type TaskEventDetailedSummaryV1Result = z.output<typeof TaskEventDetailedSummaryV1Result>;

export function getTraceDetailedSummaryQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilderFast<TaskEventDetailedSummaryV1Result>({
    name: "getTaskEventDetailedSummary",
    table: "trigger_dev.task_events_v1",
    columns: [
      "span_id",
      "parent_span_id",
      "run_id",
      "start_time",
      "duration",
      "status",
      "kind",
      "metadata",
      { name: "message", expression: "LEFT(message, 256)" },
      "attributes_text",
    ],
    settings,
  });
}

export const TaskEventDetailsV1Result = z.object({
  span_id: z.string(),
  parent_span_id: z.string(),
  start_time: z.string(),
  duration: z.number().or(z.string()),
  status: z.string(),
  kind: z.string(),
  metadata: z.string(),
  message: z.string(),
  attributes_text: z.string(),
});

export type TaskEventDetailsV1Result = z.input<typeof TaskEventDetailsV1Result>;

export function getSpanDetailsQueryBuilder(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilder({
    name: "getSpanDetails",
    baseQuery:
      "SELECT span_id, parent_span_id, start_time, duration, status, kind, metadata, message, attributes_text FROM trigger_dev.task_events_v1",
    schema: TaskEventDetailsV1Result,
    settings,
  });
}

// ============================================================================
// V2 Table Functions (partitioned by inserted_at instead of start_time)
// ============================================================================

export const TaskEventV2Input = z.object({
  environment_id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  task_identifier: z.string(),
  run_id: z.string(),
  start_time: z.string(),
  duration: z.string(),
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string(),
  message: z.string(),
  kind: z.string(),
  status: z.string(),
  attributes: z.unknown(),
  metadata: z.string(),
  expires_at: z.string(),
  // inserted_at has a default value in the table, so it's optional for inserts
  inserted_at: z.string().optional(),
});

export type TaskEventV2Input = z.input<typeof TaskEventV2Input>;

export function insertTaskEventsV2(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insertUnsafe<TaskEventV2Input>({
    name: "insertTaskEventsV2",
    table: "trigger_dev.task_events_v2",
    settings: {
      enable_json_type: 1,
      type_json_skip_duplicated_paths: 1,
      input_format_json_throw_on_bad_escape_sequence: 0,
      input_format_json_use_string_type_for_ambiguous_paths_in_named_tuples_inference_from_objects: 1,
      ...settings,
    },
  });
}

export function getTraceSummaryQueryBuilderV2(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilderFast<TaskEventSummaryV1Result>({
    name: "getTraceEventsV2",
    table: "trigger_dev.task_events_v2",
    columns: [
      "span_id",
      "parent_span_id",
      "run_id",
      "start_time",
      "duration",
      "status",
      "kind",
      "metadata",
      { name: "message", expression: "LEFT(message, 256)" },
    ],
    settings,
  });
}

export function getTraceDetailedSummaryQueryBuilderV2(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilderFast<TaskEventDetailedSummaryV1Result>({
    name: "getTaskEventDetailedSummaryV2",
    table: "trigger_dev.task_events_v2",
    columns: [
      "span_id",
      "parent_span_id",
      "run_id",
      "start_time",
      "duration",
      "status",
      "kind",
      "metadata",
      { name: "message", expression: "LEFT(message, 256)" },
      "attributes_text",
    ],
    settings,
  });
}

export function getSpanDetailsQueryBuilderV2(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilder({
    name: "getSpanDetailsV2",
    baseQuery:
      "SELECT span_id, parent_span_id, start_time, duration, status, kind, metadata, message, attributes_text FROM trigger_dev.task_events_v2",
    schema: TaskEventDetailsV1Result,
    settings,
  });
}

// ============================================================================
// Logs List Query Builders (for aggregated logs page)
// ============================================================================

export const LogsListResult = z.object({
  environment_id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  task_identifier: z.string(),
  run_id: z.string(),
  start_time: z.string(),
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string(),
  message: z.string(),
  kind: z.string(),
  status: z.string(),
  duration: z.number().or(z.string()),
  attributes_text: z.string(),
});

export type LogsListResult = z.output<typeof LogsListResult>;

export function getLogsListQueryBuilderV2(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilderFast<LogsListResult>({
    name: "getLogsList",
    table: "trigger_dev.task_events_v2",
    columns: [
      "environment_id",
      "organization_id",
      "project_id",
      "task_identifier",
      "run_id",
      "start_time",
      "trace_id",
      "span_id",
      "parent_span_id",
      { name: "message", expression: "LEFT(message, 512)" },
      "kind",
      "status",
      "duration",
      "attributes_text"
    ],
    settings,
  });
}

// Single log detail query builder (for side panel)
export const LogDetailV2Result = z.object({
  environment_id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  task_identifier: z.string(),
  run_id: z.string(),
  start_time: z.string(),
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string(),
  message: z.string(),
  kind: z.string(),
  status: z.string(),
  duration: z.number().or(z.string()),
  attributes_text: z.string()
});

export type LogDetailV2Result = z.output<typeof LogDetailV2Result>;

export function getLogDetailQueryBuilderV2(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilderFast<LogDetailV2Result>({
    name: "getLogDetail",
    table: "trigger_dev.task_events_v2",
    columns: [
      "environment_id",
      "organization_id",
      "project_id",
      "task_identifier",
      "run_id",
      "start_time",
      "trace_id",
      "span_id",
      "parent_span_id",
      "message",
      "kind",
      "status",
      "duration",
      "attributes_text",
    ],
    settings,
  });
}