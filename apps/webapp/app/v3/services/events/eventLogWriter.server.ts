import type { EventLogV1Input } from "@internal/clickhouse";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { logger } from "~/services/logger.server";
import type { EventLogEntry } from "./publishEvent.server";

const insertFn = clickhouseClient.eventLog.insert;

export function writeEventLog(entry: EventLogEntry): void {
  const row: EventLogV1Input = {
    event_id: entry.eventId,
    event_type: entry.eventType,
    payload: typeof entry.payload === "string" ? entry.payload : JSON.stringify(entry.payload),
    published_at: entry.publishedAt.toISOString(),
    environment_id: entry.environmentId,
    project_id: entry.projectId,
    organization_id: entry.organizationId,
    idempotency_key: entry.idempotencyKey,
    tags: entry.tags,
    metadata:
      entry.metadata !== undefined && entry.metadata !== null
        ? JSON.stringify(entry.metadata)
        : undefined,
    fan_out_count: entry.fanOutCount,
  };

  // Fire-and-forget: don't await, don't block the publish response
  insertFn(row).then(
    ([error]) => {
      if (error) {
        logger.error("Failed to insert event into ClickHouse event log", {
          eventId: entry.eventId,
          eventType: entry.eventType,
          error: error.message,
        });
      }
    },
    (err) => {
      logger.error("Failed to insert event into ClickHouse event log", {
        eventId: entry.eventId,
        eventType: entry.eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  );
}
