import type { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import type {
  ClickhouseInsertFunction,
  ClickhouseReader,
  ClickhouseWriter,
} from "./client/types.js";

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
  machine_id: z.string().optional(),
});

export type TaskEventV1Input = z.input<typeof TaskEventV1Input>;

export function insertTaskEvents(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insertUnsafe<TaskEventV1Input>({
    name: "insertTaskEvents",
    table: "trigger_dev.task_events_v1",
    settings: {
      enable_json_type: 1,
      type_json_skip_duplicated_paths: 1,
      input_format_json_infer_array_of_dynamic_from_array_of_different_types: 1,
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

// Row shape for streaming a whole trace out for export (the "Download trace"
// feature). Unlike the detailed-summary builders this keeps the FULL message
// (not LEFT(message, 256)) since the export is the source of truth, and it's
// consumed via executeStream() so the trace is never fully materialised.
export type TaskEventExportRow = {
  span_id: string;
  parent_span_id: string;
  start_time: string;
  duration: number | string;
  status: string;
  kind: string;
  message: string;
  attributes_text: string;
};

const TASK_EVENT_EXPORT_COLUMNS = [
  "span_id",
  "parent_span_id",
  "start_time",
  "duration",
  "status",
  "kind",
  "message",
  "attributes_text",
] as const;

export function getTraceEventsForExportQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilderFast<TaskEventExportRow>({
    name: "getTraceEventsForExport",
    table: "trigger_dev.task_events_v1",
    columns: [...TASK_EVENT_EXPORT_COLUMNS],
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

const TASK_EVENT_V2_INSERT_COLUMNS = [
  "environment_id",
  "organization_id",
  "project_id",
  "task_identifier",
  "run_id",
  "start_time",
  "duration",
  "trace_id",
  "span_id",
  "parent_span_id",
  "message",
  "kind",
  "status",
  "attributes_text",
  "metadata",
  "expires_at",
  "machine_id",
  "inserted_at",
] satisfies [string, ...string[]];

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
  machine_id: z.string().optional(),
  // inserted_at has a default value in the table, so it's optional for inserts
  inserted_at: z.string().optional(),
});

export type TaskEventV2Input = z.input<typeof TaskEventV2Input>;

type TaskEventV2Row = Omit<TaskEventV2Input, "attributes"> & {
  attributes_text: string;
};

// attributes_text is serialized by the writer rather than computed by ClickHouse,
// so the stored text is exactly what was sent and the table does not have to
// parse and re-encode the attributes on every insert.
export function serializeTaskEventAttributes(attributes: unknown): string {
  if (attributes === null || attributes === undefined) {
    return "{}";
  }

  return JSON.stringify(attributes) ?? "{}";
}

function toTaskEventV2Row(event: TaskEventV2Input): TaskEventV2Row {
  const { attributes, ...row } = event;

  return {
    ...row,
    attributes_text: serializeTaskEventAttributes(attributes),
  };
}

export function insertTaskEventsV2(
  ch: ClickhouseWriter,
  settings?: ClickHouseSettings
): ClickhouseInsertFunction<TaskEventV2Input> {
  const insert = ch.insertUnsafe<TaskEventV2Row>({
    name: "insertTaskEventsV2",
    table: "trigger_dev.task_events_v2",
    columns: TASK_EVENT_V2_INSERT_COLUMNS,
    settings: {
      input_format_json_throw_on_bad_escape_sequence: 0,
      ...settings,
    },
  });

  return (events, options) => {
    const values = Array.isArray(events) ? events.map(toTaskEventV2Row) : toTaskEventV2Row(events);

    return insert(values, options);
  };
}

export function getTraceSummaryQueryBuilderV2(ch: ClickhouseReader, settings?: ClickHouseSettings) {
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

export function getSpanDetailsQueryBuilderV2(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilder({
    name: "getSpanDetailsV2",
    baseQuery:
      "SELECT span_id, parent_span_id, start_time, duration, status, kind, metadata, message, attributes_text FROM trigger_dev.task_events_v2",
    schema: TaskEventDetailsV1Result,
    settings,
  });
}

export function getTraceEventsForExportQueryBuilderV2(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilderFast<TaskEventExportRow>({
    name: "getTraceEventsForExportV2",
    table: "trigger_dev.task_events_v2",
    columns: [...TASK_EVENT_EXPORT_COLUMNS],
    settings,
  });
}

export type TaskEventChunkV2Result = TaskEventSummaryV1Result & {
  cursor_start_time: string;
  // Write time (ms since epoch); only selected on the v2 table.
  cursor_inserted_at?: string;
};

export type TraceChunkCursor = {
  startTime: string;
  spanId: string;
};

export const TRACE_CHUNK_ORDER_BY = "start_time ASC, span_id ASC";

export function buildTraceChunkCursorPredicate(cursor: TraceChunkCursor): {
  clause: string;
  params: { cursorStartTime: string; cursorSpanId: string };
} {
  return {
    clause:
      "(toUnixTimestamp64Nano(start_time) > {cursorStartTime: Int64} OR (toUnixTimestamp64Nano(start_time) = {cursorStartTime: Int64} AND span_id > {cursorSpanId: String}))",
    params: {
      cursorStartTime: cursor.startTime,
      cursorSpanId: cursor.spanId,
    },
  };
}

export function buildTraceChunkKeyPredicate(cursor: TraceChunkCursor): {
  clause: string;
  params: { keyStartTime: string; keySpanId: string };
} {
  return {
    clause:
      "(toUnixTimestamp64Nano(start_time) = {keyStartTime: Int64} AND span_id = {keySpanId: String})",
    params: {
      keyStartTime: cursor.startTime,
      keySpanId: cursor.spanId,
    },
  };
}

const TRACE_CHUNK_COLUMNS = [
  "span_id",
  "parent_span_id",
  "run_id",
  "start_time",
  "duration",
  "status",
  "kind",
  "metadata",
  { name: "message", expression: "LEFT(message, 256)" },
  { name: "cursor_start_time", expression: "toString(toUnixTimestamp64Nano(start_time))" },
] as const;

// task_events_v1 has no inserted_at column.
const TRACE_CHUNK_COLUMNS_V2 = [
  ...TRACE_CHUNK_COLUMNS,
  { name: "cursor_inserted_at", expression: "toString(toUnixTimestamp64Milli(inserted_at))" },
] as const;

export function getTraceChunkQueryBuilder(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilderFast<TaskEventChunkV2Result>({
    name: "getTraceChunk",
    table: "trigger_dev.task_events_v1",
    columns: [...TRACE_CHUNK_COLUMNS],
    settings,
  });
}

export function getTraceChunkQueryBuilderV2(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilderFast<TaskEventChunkV2Result>({
    name: "getTraceChunkV2",
    table: "trigger_dev.task_events_v2",
    columns: [...TRACE_CHUNK_COLUMNS_V2],
    settings,
  });
}

export type TraceSpanCountResult = { count: string };
const TRACE_SPAN_COUNT_COLUMNS = [{ name: "count", expression: "uniqExact(span_id)" }] as const;

export function getTraceSpanCountQueryBuilder(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilderFast<TraceSpanCountResult>({
    name: "getTraceSpanCount",
    table: "trigger_dev.task_events_v1",
    columns: [...TRACE_SPAN_COUNT_COLUMNS],
    settings,
  });
}

export function getTraceSpanCountQueryBuilderV2(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilderFast<TraceSpanCountResult>({
    name: "getTraceSpanCountV2",
    table: "trigger_dev.task_events_v2",
    columns: [...TRACE_SPAN_COUNT_COLUMNS],
    settings,
  });
}

export type TraceChunkSlice<T> = {
  events: T[];
  nextCursor: TraceChunkCursor | null;
  hasMore: boolean;
  incompleteKey?: TraceChunkCursor;
};

export function sliceTraceChunk<T extends { cursor_start_time: string; span_id: string }>(
  rows: T[],
  limit: number
): TraceChunkSlice<T> {
  const cursorOf = (row: T): TraceChunkCursor => ({
    startTime: row.cursor_start_time,
    spanId: row.span_id,
  });
  const sameKey = (a: T, b: T) =>
    a.cursor_start_time === b.cursor_start_time && a.span_id === b.span_id;

  if (rows.length <= limit) {
    return { events: rows, nextCursor: null, hasMore: false };
  }

  const window = rows.slice(0, limit);
  const extra = rows[limit];
  const lastKept = window[window.length - 1];

  if (sameKey(extra, lastKept)) {
    let end = window.length;
    while (end > 0 && sameKey(window[end - 1], lastKept)) {
      end--;
    }

    if (end === 0) {
      return {
        events: [],
        nextCursor: cursorOf(lastKept),
        hasMore: true,
        incompleteKey: cursorOf(lastKept),
      };
    }

    const trimmed = window.slice(0, end);
    return { events: trimmed, nextCursor: cursorOf(trimmed[trimmed.length - 1]), hasMore: true };
  }

  return { events: window, nextCursor: cursorOf(lastKept), hasMore: true };
}

// ============================================================================
// Search Table Query Builders (for logs page, using task_events_search_v2)
// ============================================================================

export const LogsSearchListResult = z.object({
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
  error_message: z.string(),
  kind: z.string(),
  status: z.string(),
  duration: z.number().or(z.string()),
  triggered_timestamp: z.string(),
  projection_fingerprint_string: z.string(),
});

export type LogsSearchListResult = z.output<typeof LogsSearchListResult>;

export function getLogsSearchListQueryBuilder(ch: ClickhouseReader) {
  const createBuilder = ch.queryBuilderFast<LogsSearchListResult>({
    name: "getLogsSearchListV2",
    table: "trigger_dev.task_events_search_v2",
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
      "error_message",
      "kind",
      "status",
      "duration",
      "triggered_timestamp",
      {
        name: "projection_fingerprint_string",
        expression: "toString(projection_fingerprint)",
      },
    ],
    settings: {
      use_query_condition_cache: 1,
      ignore_data_skipping_indices: "idx_search_text",
      // Hold the response until the query finishes so a limit error arrives as an HTTP error the
      // client turns into a QueryError, not mid-stream. Pages are a few hundred small rows.
      wait_end_of_query: 1,
    },
  });

  return createBuilder;
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
  attributes_text: z.string(),
});

export type LogDetailV2Result = z.output<typeof LogDetailV2Result>;

export function getLogDetailQueryBuilderV2(ch: ClickhouseReader) {
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
  });
}
