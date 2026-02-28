import { z } from "zod";
import { ClickhouseReader, ClickhouseWriter } from "./client/types.js";

export const EventLogV1Input = z.object({
  event_id: z.string(),
  event_type: z.string(),
  payload: z.string(),
  payload_type: z.string().optional(),
  published_at: z.string(),
  environment_id: z.string(),
  project_id: z.string(),
  organization_id: z.string(),
  publisher_run_id: z.string().optional(),
  idempotency_key: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.string().optional(),
  fan_out_count: z.number().int().optional(),
});

export type EventLogV1Input = z.input<typeof EventLogV1Input>;

export const EventLogV1Output = z.object({
  event_id: z.string(),
  event_type: z.string(),
  payload: z.string(),
  payload_type: z.string(),
  published_at: z.string(),
  environment_id: z.string(),
  project_id: z.string(),
  organization_id: z.string(),
  publisher_run_id: z.string(),
  idempotency_key: z.string(),
  tags: z.array(z.string()),
  metadata: z.string(),
  fan_out_count: z.number().int(),
  inserted_at: z.string(),
});

export type EventLogV1Output = z.output<typeof EventLogV1Output>;

export function insertEventLog(ch: ClickhouseWriter) {
  return ch.insertUnsafe<EventLogV1Input>({
    name: "insertEventLog",
    table: "trigger_dev.event_log_v1",
  });
}

export function getEventLogQueryBuilder(ch: ClickhouseReader) {
  return ch.queryBuilder({
    name: "getEventLog",
    baseQuery: `SELECT
      event_id,
      event_type,
      payload,
      payload_type,
      published_at,
      environment_id,
      project_id,
      organization_id,
      publisher_run_id,
      idempotency_key,
      tags,
      metadata,
      fan_out_count,
      inserted_at
    FROM trigger_dev.event_log_v1`,
    schema: EventLogV1Output,
  });
}
