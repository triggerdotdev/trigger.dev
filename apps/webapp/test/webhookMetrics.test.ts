import type { MetricsV1Input } from "@internal/clickhouse";
import { describe, expect, it, vi } from "vitest";
import {
  createWebhookMetricsAggregator,
  createWebhookMetricsTenantLookup,
  webhookMetricsHooks,
  type WebhookMetricsAggregator,
} from "~/services/webhookMetricsAggregator.server";

const tenant = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
};

function rowsOf(
  record: (metrics: WebhookMetricsAggregator) => void,
  options: { maxSubjectsPerEntry?: number; dropped?: (count: number) => void } = {}
) {
  const sink = vi.fn<(rows: MetricsV1Input[]) => void>();
  const metrics = createWebhookMetricsAggregator({
    bucketSeconds: 10,
    maxEntries: 100,
    maxSubjectsPerEntry: options.maxSubjectsPerEntry,
    isEnabled: () => true,
    sink,
    counters: options.dropped ? { dropped: { add: options.dropped } } : undefined,
  });
  record(metrics);
  metrics.flush();
  return sink.mock.calls
    .flatMap(([rows]) => rows)
    .map((row) => [row.metric_name, row.metric_type, row.metric_subject, row.value, row.attributes])
    .sort();
}

describe("webhook metrics", () => {
  it("turns each engine hook into its rows for the environment's tenant", () => {
    const hooksInto = (metrics: WebhookMetricsAggregator) =>
      webhookMetricsHooks((environmentId, record) => record(metrics, { ...tenant, environmentId }));

    expect(
      rowsOf((m) => {
        const hooks = hooksInto(m);
        hooks.onWaiterCreated!({ environmentId: "env_1" }, 3, 100);
        hooks.onWaiterCreated!({ environmentId: "env_1" }, 5, 120);
        hooks.onWaiterReleased!({ environmentId: "env_1" }, 7);
        hooks.onWaiterCreated!({ environmentId: "env_1" }, 4, 110);
      })
    ).toEqual([
      ["webhook.waiters.limit.env", "gauge", "", 110, {}],
      ["webhook.waiters.live", "gauge", "", 7, {}],
    ]);
    expect(
      rowsOf((m) => {
        const hooks = hooksInto(m);
        hooks.onProcessing!({ environmentId: "env_1" }, 2, 10);
        hooks.onProcessing!({ environmentId: "env_1" }, 1, 12);
        hooks.onWaiterRefused!({ environmentId: "env_1" }, "shape_limit");
      })
    ).toEqual([
      ["webhook.processing.in_flight", "gauge", "", 2, {}],
      ["webhook.processing.limit", "gauge", "", 12, {}],
      ["webhook.waiters.refused", "sum", "", 1, { reason: "shape_limit" }],
    ]);
  });

  it("counts refused waiters per reason", () => {
    expect(
      rowsOf((m) => {
        m.waiterRefused(tenant, "environment_limit");
        m.waiterRefused(tenant, "endpoint_limit");
        m.waiterRefused(tenant, "environment_limit");
      })
    ).toEqual([
      ["webhook.waiters.refused", "sum", "", 1, { reason: "endpoint_limit" }],
      ["webhook.waiters.refused", "sum", "", 2, { reason: "environment_limit" }],
    ]);
  });

  it("rolls ingress counts, not gauges, up to the environment", () => {
    const endpoint = { scope: "endpoint" };
    expect(
      rowsOf((m) => {
        m.ingress(tenant, "endpoint", { opaqueId: "wh_a", success: true, tokens: 5, remaining: 1 });
        m.ingress(tenant, "endpoint", {
          opaqueId: "wh_a",
          success: false,
          tokens: 5,
          remaining: -1,
        });
        m.ingress(tenant, "env", { opaqueId: "wh_a", success: false, tokens: 50, remaining: 0 });
        m.ingress(tenant, "body", { opaqueId: "wh_a", success: false });
        m.ingressAllowed(tenant, "wh_a");
      })
    ).toEqual(
      [
        ["webhook.ingress.allowed", "sum", "", 1, {}],
        ["webhook.ingress.allowed", "sum", "wh_a", 1, {}],
        ["webhook.ingress.denied", "sum", "", 1, endpoint],
        ["webhook.ingress.denied", "sum", "wh_a", 1, endpoint],
        ["webhook.ingress.denied", "sum", "", 1, { scope: "env" }],
        ["webhook.ingress.denied", "sum", "", 1, { scope: "body" }],
        ["webhook.ingress.limit.tokens", "gauge", "wh_a", 5, endpoint],
        ["webhook.ingress.limit.tokens", "gauge", "", 50, { scope: "env" }],
        ["webhook.ingress.remaining_min", "gauge", "wh_a", 0, endpoint],
        ["webhook.ingress.remaining_min", "gauge", "", 0, { scope: "env" }],
      ].sort()
    );
  });

  it("caps endpoint subjects per entry but keeps the environment totals", () => {
    const dropped = vi.fn<(count: number) => void>();
    const rows = rowsOf(
      (m) => {
        for (let i = 0; i < 501; i++) m.ingressAllowed(tenant, `wh_${i}`);
      },
      { maxSubjectsPerEntry: 500, dropped }
    );

    expect(rows.filter(([, , subject]) => subject !== "")).toHaveLength(500);
    expect(rows.filter(([, , subject]) => subject === "")).toEqual([
      ["webhook.ingress.allowed", "sum", "", 501, {}],
    ]);
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledWith(1, { reason: "subjects" });
  });

  it("caches an environment that doesn't exist", async () => {
    let loads = 0;
    const lookup = createWebhookMetricsTenantLookup(async () => {
      loads++;
      return null;
    });

    expect(await lookup("env_missing")).toBeNull();
    expect(await lookup("env_missing")).toBeNull();
    expect(loads).toBe(1);
  });
});
