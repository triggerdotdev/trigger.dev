import type { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import type { ClickhouseReader, ClickhouseWriter } from "./client/types.js";

export const WebhookDeliveryV1 = z.object({
  environment_id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  delivery_id: z.string(),
  webhook_endpoint_id: z.string(),
  environment_type: z.string(),
  friendly_id: z.string(),
  external_delivery_id: z.string().default(""),
  run_id: z.string().default(""),
  status: z.string(),
  is_test: z.number().int().default(0),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  _version: z.string(),
  _is_deleted: z.number().int().default(0),
});
export type WebhookDeliveryV1 = z.input<typeof WebhookDeliveryV1>;

export const WEBHOOK_DELIVERY_COLUMNS = [
  "environment_id",
  "organization_id",
  "project_id",
  "delivery_id",
  "webhook_endpoint_id",
  "environment_type",
  "friendly_id",
  "external_delivery_id",
  "run_id",
  "status",
  "is_test",
  "created_at",
  "updated_at",
  "_version",
  "_is_deleted",
] as const;

export type WebhookDeliveryColumnName = (typeof WEBHOOK_DELIVERY_COLUMNS)[number];

export const WEBHOOK_DELIVERY_INDEX = Object.fromEntries(
  WEBHOOK_DELIVERY_COLUMNS.map((col, idx) => [col, idx])
) as { readonly [K in WebhookDeliveryColumnName]: number };

export type WebhookDeliveryFieldTypes = {
  environment_id: string;
  organization_id: string;
  project_id: string;
  delivery_id: string;
  webhook_endpoint_id: string;
  environment_type: string;
  friendly_id: string;
  external_delivery_id: string;
  run_id: string;
  status: string;
  is_test: number;
  created_at: number;
  updated_at: number;
  _version: string;
  _is_deleted: number;
};

export type WebhookDeliveryInsertArray = [
  environment_id: string,
  organization_id: string,
  project_id: string,
  delivery_id: string,
  webhook_endpoint_id: string,
  environment_type: string,
  friendly_id: string,
  external_delivery_id: string,
  run_id: string,
  status: string,
  is_test: number,
  created_at: number,
  updated_at: number,
  _version: string,
  _is_deleted: number,
];

export function getWebhookDeliveryField<K extends WebhookDeliveryColumnName>(
  row: WebhookDeliveryInsertArray,
  field: K
): WebhookDeliveryFieldTypes[K] {
  return row[WEBHOOK_DELIVERY_INDEX[field]] as WebhookDeliveryFieldTypes[K];
}

export function insertWebhookDeliveriesCompactArrays(
  ch: ClickhouseWriter,
  settings?: ClickHouseSettings
) {
  return ch.insertCompactRaw({
    name: "insertWebhookDeliveriesCompactArrays",
    table: "trigger_dev.webhook_deliveries_v1",
    columns: WEBHOOK_DELIVERY_COLUMNS,
    settings, // no enable_json_type
  });
}

export const WebhookDeliveryV1QueryResult = z.object({
  delivery_id: z.string(),
  created_at_ms: z.number().int(),
});
export type WebhookDeliveryV1QueryResult = z.infer<typeof WebhookDeliveryV1QueryResult>;

export function getWebhookDeliveriesQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilder({
    name: "getWebhookDeliveries",
    baseQuery:
      "SELECT delivery_id, toUnixTimestamp64Milli(created_at) AS created_at_ms FROM trigger_dev.webhook_deliveries_v1 FINAL",
    schema: WebhookDeliveryV1QueryResult,
    settings,
  });
}

export function getWebhookDeliveriesCountQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilder({
    name: "getWebhookDeliveriesCount",
    baseQuery: "SELECT count() as count FROM trigger_dev.webhook_deliveries_v1 FINAL",
    schema: z.object({ count: z.number().int() }),
    settings,
  });
}

export const WebhookDeliveryGroupedCountResult = z.object({
  webhook_endpoint_id: z.string(),
  count: z.number().int(),
});
export type WebhookDeliveryGroupedCountResult = z.infer<typeof WebhookDeliveryGroupedCountResult>;

// Per-endpoint delivery counts in one query (caller adds the scope/period WHERE + GROUP BY). Uses
// count(DISTINCT delivery_id) instead of FINAL: it dedupes the ReplacingMergeTree version rows (one
// per status transition) without the full-merge cost of FINAL, which matters when counting per
// endpoint for a list.
export function getWebhookDeliveriesGroupedCountQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilder({
    name: "getWebhookDeliveriesGroupedCount",
    baseQuery:
      "SELECT webhook_endpoint_id, count(DISTINCT delivery_id) AS count FROM trigger_dev.webhook_deliveries_v1",
    schema: WebhookDeliveryGroupedCountResult,
    settings,
  });
}
