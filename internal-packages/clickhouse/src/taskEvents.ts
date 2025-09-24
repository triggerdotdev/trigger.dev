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
      ...settings,
    },
  });
}

export const TraceSummaryV1QueryParams = z.object({
  traceId: z.string(),
  startTimeRange: z.object({
    start: z.string(),
    end: z.string(),
  }),
});

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

export type TaskEventSummaryV1Result = z.input<typeof TaskEventSummaryV1Result>;

export function getTraceSummaryQueryBuilder(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilder({
    name: "getTraceEvents",
    baseQuery:
      "SELECT span_id, parent_span_id, run_id, start_time, duration, status, kind, metadata, message FROM trigger_dev.task_events_v1",
    schema: TaskEventSummaryV1Result,
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
  attributes: z.unknown(),
});

export type TaskEventDetailsV1Result = z.input<typeof TaskEventDetailsV1Result>;

export function getSpanDetailsQueryBuilder(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilder({
    name: "getSpanDetails",
    baseQuery:
      "SELECT span_id, parent_span_id, start_time, duration, status, kind, metadata, message, attributes FROM trigger_dev.task_events_v1",
    schema: TaskEventDetailsV1Result,
    settings,
  });
}
