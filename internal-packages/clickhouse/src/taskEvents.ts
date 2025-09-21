import { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import { ClickhouseReader, ClickhouseWriter } from "./client/types.js";

export const TaskEventV1 = z.object({
  environment_id: z.string(),
  organization_id: z.string(),
  task_identifier: z.string(),
  run_id: z.string(),
  start_time: z.bigint(),
  duration: z.bigint(),
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string(),
  message: z.string(),
  kind: z.string(),
  status: z.string(),
  attributes: z.unknown(),
  metadata: z.string(),
  expires_at: z.coerce.date(),
});

export type TaskEventV1 = z.input<typeof TaskEventV1>;

export function insertTaskEvents(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insertUnsafe<TaskEventV1>({
    name: "insertTaskEvents",
    table: "trigger_dev.task_events_v1",
    settings: {
      enable_json_type: 1,
      type_json_skip_duplicated_paths: 1,
      ...settings,
    },
  });
}
