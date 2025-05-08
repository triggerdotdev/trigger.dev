import { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import { ClickhouseWriter } from "./client/types.js";

export const TaskRunV1 = z.object({
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
  _version: z.string(),
  _is_deleted: z.number().int().default(0),
});

export type TaskRunV1 = z.input<typeof TaskRunV1>;

export function insertTaskRuns(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insert({
    name: "insertTaskRuns",
    table: "trigger_dev.task_runs_v1",
    schema: TaskRunV1,
    settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
      async_insert_max_data_size: "1000000",
      async_insert_busy_timeout_ms: 1000,
      enable_json_type: 1,
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
      ...settings,
    },
  });
}
