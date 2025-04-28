import { z } from "zod";
import { ClickhouseWriter } from "./client/types.js";
import { ClickHouseSettings } from "@clickhouse/client";
import { TaskRunError } from "@trigger.dev/core/v3/schemas";

export const RawRunEventV1 = z.object({
  environment_id: z.string(),
  run_id: z.string(),
  friendly_id: z.string(),
  attempt: z.number().int().default(1),
  engine: z.enum(["V1", "V2"]),
  status: z.enum([
    "DELAYED",
    "PENDING",
    "PENDING_VERSION",
    "WAITING_FOR_DEPLOY",
    "WAITING_FOR_EVENT",
    "RUNNING",
    "WAITING",
    "PAUSED",
    "COMPLETED_SUCCESSFULLY",
    "FAILED",
    "CANCELED",
    "INTERRUPTED",
    "CRASHED",
    "EXPIRED",
    "TIMED_OUT",
  ]),
  task_identifier: z.string(),
  queue: z.string(),
  schedule_id: z.string().optional(),
  batch_id: z.string().optional(),
  event_time: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  completed_at: z.number().int().optional(),
  started_at: z.number().int().optional(),
  executed_at: z.number().int().optional(),
  finished_at: z.number().int().optional(),
  delay_until: z.number().int().optional(),
  queued_at: z.number().int().optional(),
  expired_at: z.number().int().optional(),
  duration_ms: z.number().int().optional(),
  usage_duration_ms: z.number().int().optional(),
  cost_in_cents: z.number().int().optional(),
  payload: z.unknown().optional(),
  output: z.unknown().optional(),
  error: TaskRunError.optional(),
  tags: z.array(z.string()).transform((arr) => arr.sort()),
  task_version: z.string().optional(),
  sdk_version: z.string().optional(),
  cli_version: z.string().optional(),
  machine_preset: z.string().optional(),
  root_run_id: z.string().optional(),
  parent_run_id: z.string().optional(),
  depth: z.number().int().default(0),
  span_id: z.string().optional(),
  trace_id: z.string().optional(),
  idempotency_key: z.string().optional(),
  expiration_ttl: z.string().optional(),
  is_test: z.boolean().default(false),
});

export type RawRunEventV1 = z.infer<typeof RawRunEventV1>;

export function insertRunEvents(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insert({
    name: "insertRunEvents",
    table: "trigger_dev.raw_run_events_v1",
    schema: RawRunEventV1,
    settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
      async_insert_max_data_size: "1000000",
      async_insert_busy_timeout_ms: 1000,
      ...settings,
    },
  });
}
