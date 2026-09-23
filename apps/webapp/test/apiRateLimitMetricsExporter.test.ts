import type { MetricsV1Input } from "@internal/clickhouse";
import { describe, expect, it, vi } from "vitest";
import {
  apiRateLimitMetricsInsertSettings,
  exportApiRateLimitMetricRows,
  type ApiRateLimitMetricsInsertClient,
} from "~/services/apiRateLimitMetricsExporter.server";

function row(organizationId: string, metricName = "api.rate_limit.allowed"): MetricsV1Input {
  return {
    organization_id: organizationId,
    project_id: `proj_${organizationId}`,
    environment_id: `env_${organizationId}`,
    metric_name: metricName,
    metric_type: "sum",
    metric_subject: "",
    bucket_start: "2026-01-15 09:30:00",
    value: 1,
    attributes: {},
  };
}

type InsertFn = ApiRateLimitMetricsInsertClient["metrics"]["insert"];

function fakeClient(result: unknown) {
  const insert = vi.fn(async () => result as never);
  const client: ApiRateLimitMetricsInsertClient = { metrics: { insert: insert as InsertFn } };
  return { client, insert };
}

const settings = apiRateLimitMetricsInsertSettings({
  waitForAsyncInsert: false,
  busyTimeoutMs: 10_000,
});

describe("apiRateLimitMetricsInsertSettings", () => {
  it("queues rows as async inserts with a fixed busy timeout", () => {
    expect(settings).toEqual({
      async_insert: 1,
      wait_for_async_insert: 0,
      async_insert_use_adaptive_busy_timeout: 0,
      async_insert_busy_timeout_ms: 10_000,
      async_insert_max_data_size: "1048576",
    });
    expect(
      apiRateLimitMetricsInsertSettings({ waitForAsyncInsert: true, busyTimeoutMs: 2_500 })
    ).toMatchObject({ wait_for_async_insert: 1, async_insert_busy_timeout_ms: 2_500 });
  });
});

describe("exportApiRateLimitMetricRows", () => {
  it("groups rows by the client that owns each organization and inserts once per client", async () => {
    const shared = fakeClient([null, {}]);
    const dedicated = fakeClient([null, {}]);
    const onInsertError = vi.fn();

    await exportApiRateLimitMetricRows(
      [row("org_a"), row("org_b"), row("org_a", "api.rate_limit.denied"), row("org_dedicated")],
      {
        resolveClient: (organizationId) =>
          organizationId === "org_dedicated" ? dedicated.client : shared.client,
        settings,
        onInsertError,
      }
    );

    expect(shared.insert).toHaveBeenCalledTimes(1);
    expect(shared.insert.mock.calls[0]![0]).toHaveLength(3);
    expect(shared.insert.mock.calls[0]![1]).toEqual({ params: { clickhouse_settings: settings } });
    expect(dedicated.insert).toHaveBeenCalledTimes(1);
    expect(dedicated.insert.mock.calls[0]![0]).toEqual([row("org_dedicated")]);
    expect(onInsertError).not.toHaveBeenCalled();
  });

  it("reports a rejected group with its row count and still inserts the other groups", async () => {
    const failure = new Error("Unknown setting");
    const broken = fakeClient([failure, null]);
    const healthy = fakeClient([null, {}]);
    const onInsertError = vi.fn();

    await exportApiRateLimitMetricRows([row("org_a"), row("org_a"), row("org_b")], {
      resolveClient: (organizationId) =>
        organizationId === "org_a" ? broken.client : healthy.client,
      settings,
      onInsertError,
    });

    expect(onInsertError).toHaveBeenCalledTimes(1);
    expect(onInsertError).toHaveBeenCalledWith(2, failure);
    expect(healthy.insert).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty batch", async () => {
    const client = fakeClient([null, {}]);
    await exportApiRateLimitMetricRows([], {
      resolveClient: () => client.client,
      settings,
      onInsertError: vi.fn(),
    });
    expect(client.insert).not.toHaveBeenCalled();
  });
});
