import { z } from "zod";
import { ClickhouseWriter } from "./client/types.js";
import { ClickHouseSettings } from "@clickhouse/client";
import { TaskRunError } from "@trigger.dev/core/v3/schemas";

export const RawRunEventV1 = z.object({
  environment_id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  run_id: z.string(),
  updated_at: z.number().int(),
  created_at: z.number().int(),
  event_time: z.number().int(),
  event_name: z.string(),
  status: z.enum([
    "DELAYED",
    "PENDING",
    "PENDING_VERSION",
    "WAITING_FOR_DEPLOY",
    "EXECUTING",
    "WAITING_TO_RESUME",
    "RETRYING_AFTER_FAILURE",
    "PAUSED",
    "CANCELED",
    "INTERRUPTED",
    "COMPLETED_SUCCESSFULLY",
    "COMPLETED_WITH_ERRORS",
    "SYSTEM_FAILURE",
    "CRASHED",
    "EXPIRED",
    "TIMED_OUT",
  ]),
  /* ─── optional fields ─────────────────────────────────────────────── */
  environment_type: z.string().nullish(),
  friendly_id: z.string().nullish(),
  attempt: z.number().int().default(1),
  engine: z.enum(["V1", "V2"]).nullish(),
  task_identifier: z.string().nullish(),
  queue: z.string().nullish(),
  schedule_id: z.string().nullish(),
  batch_id: z.string().nullish(),
  completed_at: z.number().int().nullish(),
  started_at: z.number().int().nullish(),
  executed_at: z.number().int().nullish(),
  delay_until: z.number().int().nullish(),
  queued_at: z.number().int().nullish(),
  expired_at: z.number().int().nullish(),
  usage_duration_ms: z.number().int().nullish(),
  cost_in_cents: z.number().nullish(),
  base_cost_in_cents: z.number().nullish(),
  payload: z.unknown().nullish(),
  output: z.unknown().nullish(),
  error: TaskRunError.nullish(),
  tags: z
    .array(z.string())
    .transform((arr) => arr.sort())
    .nullish(),
  task_version: z.string().nullish(),
  sdk_version: z.string().nullish(),
  cli_version: z.string().nullish(),
  machine_preset: z.string().nullish(),
  root_run_id: z.string().nullish(),
  parent_run_id: z.string().nullish(),
  depth: z.number().int().default(0),
  span_id: z.string().nullish(),
  trace_id: z.string().nullish(),
  idempotency_key: z.string().nullish(),
  expiration_ttl: z.string().nullish(),
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
