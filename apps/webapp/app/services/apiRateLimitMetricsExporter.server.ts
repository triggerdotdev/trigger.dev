import type { ClickHouse, ClickHouseSettings, MetricsV1Input } from "@internal/clickhouse";

export type ApiRateLimitMetricsInsertClient = Pick<ClickHouse, "metrics">;

export type ApiRateLimitMetricsExporterOptions = {
  resolveClient: (organizationId: string) => ApiRateLimitMetricsInsertClient;
  settings: ClickHouseSettings;
  /** Called with the size of a group whose insert request ClickHouse rejected. */
  onInsertError: (rows: number, error: unknown) => void;
};

/**
 * Every API replica flushes a handful of rows every few seconds. Sent as async inserts, the
 * server queues them and writes one part per busy-timeout window (or per 450 queued inserts)
 * instead of one part per replica per flush. The adaptive timeout is disabled because it
 * shrinks towards its floor under exactly this sparse, periodic pattern.
 *
 * Without waiting for the async insert, ClickHouse acknowledges once the rows are queued, so a
 * failure while writing the part is only visible in system.asynchronous_insert_log.
 */
export function apiRateLimitMetricsInsertSettings(options: {
  waitForAsyncInsert: boolean;
  busyTimeoutMs: number;
}): ClickHouseSettings {
  return {
    async_insert: 1,
    wait_for_async_insert: options.waitForAsyncInsert ? 1 : 0,
    async_insert_use_adaptive_busy_timeout: 0,
    async_insert_busy_timeout_ms: options.busyTimeoutMs,
    async_insert_max_data_size: "1048576",
  };
}

/**
 * Groups rows by the ClickHouse client that owns their organization and inserts each group. A
 * rejected group is reported through onInsertError and never blocks the other groups.
 */
export async function exportApiRateLimitMetricRows(
  rows: MetricsV1Input[],
  options: ApiRateLimitMetricsExporterOptions
): Promise<void> {
  const groups = new Map<ApiRateLimitMetricsInsertClient, MetricsV1Input[]>();

  for (const row of rows) {
    const client = options.resolveClient(row.organization_id);
    let group = groups.get(client);
    if (!group) {
      group = [];
      groups.set(client, group);
    }
    group.push(row);
  }

  await Promise.all(
    Array.from(groups, async ([client, groupedRows]) => {
      const [error] = await client.metrics.insert(groupedRows, {
        params: { clickhouse_settings: options.settings },
      });
      if (error) {
        options.onInsertError(groupedRows.length, error);
      }
    })
  );
}
