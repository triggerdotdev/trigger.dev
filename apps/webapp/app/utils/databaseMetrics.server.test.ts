import { describe, expect, it } from "vitest";
import {
  normalizeDatabaseMetrics,
  type DatabaseMetricsSource,
  type MetricHistogramValue,
} from "./databaseMetrics.server";

const durationHistogram: MetricHistogramValue = {
  buckets: [
    [1, 10],
    [10, 5],
  ],
  sum: 1234,
  count: 15,
};

function quaintJson() {
  return {
    counters: [
      { key: "prisma_client_queries_total", value: 100 },
      { key: "prisma_datasource_queries_total", value: 250 },
      { key: "prisma_pool_connections_opened_total", value: 12 },
      { key: "prisma_pool_connections_closed_total", value: 3 },
    ],
    gauges: [
      { key: "prisma_client_queries_active", value: 4 },
      { key: "prisma_client_queries_wait", value: 2 },
      { key: "prisma_pool_connections_open", value: 9 },
      { key: "prisma_pool_connections_busy", value: 4 },
      { key: "prisma_pool_connections_idle", value: 5 },
    ],
    histograms: [{ key: "prisma_client_queries_duration_histogram_ms", value: durationHistogram }],
  };
}

const stubClient = { $metrics: { json: async () => quaintJson() } };

describe("normalizeDatabaseMetrics", () => {
  it("reads pool figures from $metrics for a quaint (Rust) client", () => {
    const source: DatabaseMetricsSource = {
      clientType: "writer",
      usesDriverAdapter: false,
      client: stubClient,
    };

    const result = normalizeDatabaseMetrics(source, quaintJson());

    expect(result.driver).toBe("quaint");
    expect(result.clientType).toBe("writer");
    expect(result.engineMetricsAvailable).toBe(true);
    expect(result.pool).toEqual({
      open: 9,
      busy: 4,
      idle: 5,
      waiting: 0,
      openedTotal: 12,
      closedTotal: 3,
    });
    expect(result.counters).toEqual({ queriesTotal: 100, datasourceQueriesTotal: 250 });
    expect(result.gauges).toEqual({ queriesActive: 4, queriesWait: 2 });
    expect(result.histograms.queriesDuration).toEqual(durationHistogram);
  });

  it("reads pool figures from pg.Pool for a driver-adapter client and keeps engine query metrics", () => {
    const source: DatabaseMetricsSource = {
      clientType: "control-plane-writer",
      usesDriverAdapter: true,
      client: stubClient,
      pool: { totalCount: 8, idleCount: 3, waitingCount: 6 },
      poolCounters: { opened: () => 20, closed: () => 12 },
    };

    const result = normalizeDatabaseMetrics(source, quaintJson());

    expect(result.driver).toBe("pg-adapter");
    expect(result.engineMetricsAvailable).toBe(true);
    expect(result.pool).toEqual({
      open: 8,
      busy: 5,
      idle: 3,
      waiting: 6,
      openedTotal: 20,
      closedTotal: 12,
    });
    expect(result.counters).toEqual({ queriesTotal: 100, datasourceQueriesTotal: 250 });
  });

  it("does not report negative busy when idle exceeds total for an adapter pool", () => {
    const source: DatabaseMetricsSource = {
      clientType: "reader",
      usesDriverAdapter: true,
      client: stubClient,
      pool: { totalCount: 2, idleCount: 5, waitingCount: 0 },
      poolCounters: { opened: () => 0, closed: () => 0 },
    };

    const result = normalizeDatabaseMetrics(source, quaintJson());

    expect(result.pool?.busy).toBe(0);
  });

  it("omits engine-derived metrics and pool when $metrics is unavailable for a quaint client", () => {
    const source: DatabaseMetricsSource = {
      clientType: "writer",
      usesDriverAdapter: false,
      client: stubClient,
    };

    const result = normalizeDatabaseMetrics(source, undefined);

    expect(result.engineMetricsAvailable).toBe(false);
    expect(result.pool).toBeUndefined();
    expect(result.counters).toBeUndefined();
    expect(result.gauges).toBeUndefined();
    expect(result.histograms.queriesDuration).toBeUndefined();
  });

  it("keeps pg.Pool figures but omits engine metrics when $metrics is unavailable for an adapter client", () => {
    const source: DatabaseMetricsSource = {
      clientType: "control-plane-writer",
      usesDriverAdapter: true,
      client: stubClient,
      pool: { totalCount: 7, idleCount: 2, waitingCount: 1 },
      poolCounters: { opened: () => 9, closed: () => 2 },
    };

    const result = normalizeDatabaseMetrics(source, undefined);

    expect(result.engineMetricsAvailable).toBe(false);
    expect(result.pool).toEqual({
      open: 7,
      busy: 5,
      idle: 2,
      waiting: 1,
      openedTotal: 9,
      closedTotal: 2,
    });
    expect(result.counters).toBeUndefined();
    expect(result.gauges).toBeUndefined();
  });
});
