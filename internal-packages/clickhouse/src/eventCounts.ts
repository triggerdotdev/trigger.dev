import { z } from "zod";
import { ClickhouseReader } from "./client/types.js";

export const EventCountsV1Output = z.object({
  project_id: z.string(),
  environment_id: z.string(),
  event_type: z.string(),
  bucket_start: z.string(),
  event_count: z.number().int(),
  total_fan_out: z.number().int(),
});

export type EventCountsV1Output = z.output<typeof EventCountsV1Output>;

export function getEventCountsQueryBuilder(ch: ClickhouseReader) {
  return ch.queryBuilder({
    name: "getEventCounts",
    baseQuery: `SELECT
      project_id,
      environment_id,
      event_type,
      bucket_start,
      event_count,
      total_fan_out
    FROM trigger_dev.event_counts_v1`,
    schema: EventCountsV1Output,
  });
}
