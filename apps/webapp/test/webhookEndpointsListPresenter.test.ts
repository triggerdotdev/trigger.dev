import { ClickHouse, type WebhookEndpointInsertArray } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import { WebhookEndpointsListPresenter } from "~/presenters/v3/WebhookEndpointsListPresenter.server";

vi.setConfig({ testTimeout: 60_000 });

const scope = {
  organizationId: "org_activity",
  projectId: "project_activity",
  environmentId: "env_activity",
};

function endpointRow(): WebhookEndpointInsertArray {
  const now = Date.now();
  return [
    scope.organizationId,
    scope.projectId,
    scope.environmentId,
    "ep_activity",
    "wh_activity",
    "opaque_activity",
    "payments",
    "",
    "",
    "stripe",
    "ACTIVE",
    0,
    1,
    [],
    "[]",
    now,
    now,
    String(now),
    0,
  ];
}

async function deliveryScans(clickhouse: ClickHouse, since: string): Promise<number> {
  const [flushError] = await clickhouse.writer.command({
    name: "flush-logs",
    query: "SYSTEM FLUSH LOGS",
  })({});
  if (flushError) throw flushError;
  const [error, rows] = await clickhouse.reader.query({
    name: "read-delivery-scans",
    query: `SELECT count() AS scans FROM system.query_log
      WHERE type = 'QueryFinish'
        AND query_kind = 'Select'
        AND has(tables, 'trigger_dev.webhook_deliveries_v2')
        AND query_start_time_microseconds > toDateTime64({since: String}, 6)`,
    params: z.object({ since: z.string() }),
    schema: z.object({ scans: z.coerce.number() }),
  })({ since });
  if (error) throw error;
  return rows[0]!.scans;
}

describe("WebhookEndpointsListPresenter activity", () => {
  // Catches: includeActivity: false still starting the 24-hour delivery aggregation.
  clickhouseTest.for([
    { includeActivity: undefined, scans: 1 },
    { includeActivity: false, scans: 0 },
  ])(
    "includeActivity $includeActivity issues $scans delivery queries",
    async ({ includeActivity, scans }, { clickhouseContainer }) => {
      const url = clickhouseContainer.getConnectionUrl();
      const clickhouse = new ClickHouse({ url, name: "presenter-activity" });
      const [insertError] = await clickhouse.webhookEndpoints.insertCompactArrays([endpointRow()], {
        params: { clickhouse_settings: { async_insert: 0 } },
      });
      expect(insertError).toBeNull();
      const [nowError, nowRows] = await clickhouse.reader.query({
        name: "read-server-now",
        query: "SELECT toString(now64(6)) AS now",
        schema: z.object({ now: z.string() }),
      })({});
      if (nowError) throw nowError;

      const list = await new WebhookEndpointsListPresenter(clickhouse).call({
        ...scope,
        includeActivity,
      });
      await list.activity;

      expect(list.endpoints).toHaveLength(1);
      expect(await deliveryScans(clickhouse, nowRows[0]!.now)).toBe(scans);
      await clickhouse.close();
    }
  );
});
