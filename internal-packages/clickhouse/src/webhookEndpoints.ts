import type { ClickHouseSettings } from "@clickhouse/client";
import type { ClickhouseWriter } from "./client/types.js";

export const WEBHOOK_ENDPOINT_COLUMNS = [
  "organization_id",
  "project_id",
  "environment_id",
  "endpoint_id",
  "friendly_id",
  "opaque_id",
  "declared_id",
  "endpoint_tenant_id",
  "endpoint_external_ref",
  "source",
  "status",
  "manually_deactivated",
  "has_signing_secret",
  "subscriber_ids",
  "subscribers",
  "created_at",
  "updated_at",
  "_version",
  "_is_deleted",
] as const;

export type WebhookEndpointInsertArray = [
  organization_id: string,
  project_id: string,
  environment_id: string,
  endpoint_id: string,
  friendly_id: string,
  opaque_id: string,
  declared_id: string,
  endpoint_tenant_id: string,
  endpoint_external_ref: string,
  source: string,
  status: string,
  manually_deactivated: number,
  has_signing_secret: number,
  subscriber_ids: string[],
  subscribers: string,
  created_at: number,
  updated_at: number,
  _version: string,
  _is_deleted: number,
];

export function insertWebhookEndpointsCompactArrays(
  ch: ClickhouseWriter,
  settings?: ClickHouseSettings
) {
  return ch.insertCompactRaw({
    name: "insertWebhookEndpointsCompactArrays",
    table: "trigger_dev.webhook_endpoints_v1",
    columns: WEBHOOK_ENDPOINT_COLUMNS,
    settings,
  });
}
