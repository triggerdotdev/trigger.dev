import { afterEach, describe, expect, it } from "vitest";
import {
  buildBucketedQuery,
  clearMetricCache,
  fillBuckets,
  fillMetricBuckets,
  getMetricSeries,
  metricCacheSize,
  alertLifetimeWindow,
  planHealthChartEvents,
} from "./alertSeries.server";
import {
  buildHealthBands,
  mapEventsToTimeline,
  pickThresholdSeries,
  quietWindowBounds,
} from "~/components/alerts/alertSeriesTypes";
import type { MetricSeriesPoint } from "~/components/alerts/alertSeriesTypes";
import { visibleSeriesKeys } from "~/components/alerts/AlertThresholdChart";
import { getCapability, type AlertCapability, type AlertParams } from "@internal/alert-contracts";
import type { QueryRowRunner } from "./evaluators/queryEvaluator.server";

describe("fillBuckets", () => {
  it("fills gaps with zeros", () => {
    const since = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-01T04:00:00Z");
    const sparse = [{ bucket: new Date("2026-01-01T01:00:00Z"), count: 5 }];

    const result = fillBuckets(sparse, since, now, 3600);

    expect(result.length).toBe(4);
    expect(result[0]!.count).toBe(0);
    expect(result[1]!.count).toBe(5);
    expect(result[2]!.count).toBe(0);
    expect(result[3]!.count).toBe(0);
  });

  it("caps at 48 buckets", () => {
    const since = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-04T00:00:00Z");
    const result = fillBuckets([], since, now, 3600);
    expect(result.length).toBe(48);
  });

  it("returns empty when window is zero", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const result = fillBuckets([], now, now, 3600);
    expect(result.length).toBe(0);
  });

  it("aggregates sparse entries into the correct bucket", () => {
    const since = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-01T02:00:00Z");
    const sparse = [
      { bucket: new Date("2026-01-01T00:15:00Z"), count: 3 },
      { bucket: new Date("2026-01-01T00:45:00Z"), count: 2 },
    ];
    const result = fillBuckets(sparse, since, now, 3600);
    expect(result.length).toBe(2);
    expect(result[0]!.count).toBe(5);
    expect(result[1]!.count).toBe(0);
  });

  it("preserves date alignment", () => {
    const since = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-01T03:00:00Z");
    const result = fillBuckets([], since, now, 3600);
    expect(result[0]!.date.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(result[1]!.date.toISOString()).toBe("2026-01-01T01:00:00.000Z");
    expect(result[2]!.date.toISOString()).toBe("2026-01-01T02:00:00.000Z");
  });
});

describe("buildBucketedQuery", () => {
  it("keeps a GROUP BY inside a string literal in the WHERE clause", () => {
    const sql = buildBucketedQuery({
      template: "SELECT count() FROM runs WHERE {{scope}} GROUP BY queue",
      table: "runs",
      scope: "queue = 'x GROUP BY y'",
      bucketSeconds: 300,
      maxBuckets: 48,
      grouped: false,
    });
    expect(sql).toContain("WHERE queue = 'x GROUP BY y' GROUP BY bucket");
  });

  it("generates GROUP BY bucket for a scalar template", () => {
    const sql = buildBucketedQuery({
      template: "SELECT count() FROM runs WHERE {{scope}}",
      table: "runs",
      scope: "1 = 1",
      bucketSeconds: 300,
      maxBuckets: 48,
      grouped: false,
    });
    expect(sql).toContain("GROUP BY bucket");
    expect(sql).toContain("toStartOfInterval");
    expect(sql).toContain("ORDER BY bucket DESC");
    expect(sql).toContain("LIMIT 48");
  });

  it("bounds LIMIT to maxBuckets for ungrouped queries", () => {
    const sql = buildBucketedQuery({
      template: "SELECT max(max_queued) FROM concurrency_metrics WHERE {{scope}}",
      table: "concurrency_metrics",
      scope: "queue = 'test'",
      bucketSeconds: 300,
      maxBuckets: 48,
      grouped: false,
    });
    expect(sql).toMatch(/LIMIT 48$/);
  });

  it("selects top-5 keys via subquery for grouped queries", () => {
    const sql = buildBucketedQuery({
      template:
        "SELECT queue, max(max_queued) FROM concurrency_metrics WHERE {{scope}} GROUP BY queue",
      table: "concurrency_metrics",
      scope: "1 = 1",
      bucketSeconds: 300,
      maxBuckets: 48,
      grouped: true,
    });
    expect(sql).toContain("GROUP BY bucket, key");
    expect(sql).toContain("IN (SELECT");
    expect(sql).toContain("LIMIT 5");
    expect(sql).toMatch(/LIMIT 240$/);
  });

  it("falls back to ungrouped when grouped=true but template has no GROUP BY", () => {
    const sql = buildBucketedQuery({
      template: "SELECT count() FROM runs WHERE {{scope}}",
      table: "runs",
      scope: "1 = 1",
      bucketSeconds: 600,
      maxBuckets: 48,
      grouped: true,
    });
    expect(sql).not.toContain("key");
    expect(sql).toContain("GROUP BY bucket");
    expect(sql).toMatch(/LIMIT 48$/);
  });

  it("uses bucket_start for concurrency_metrics table", () => {
    const sql = buildBucketedQuery({
      template: "SELECT max(max_queued) FROM concurrency_metrics WHERE {{scope}}",
      table: "concurrency_metrics",
      scope: "1 = 1",
      bucketSeconds: 300,
      maxBuckets: 48,
      grouped: false,
    });
    expect(sql).toContain("bucket_start");
  });

  it("uses triggered_at for runs table", () => {
    const sql = buildBucketedQuery({
      template: "SELECT count() FROM runs WHERE {{scope}}",
      table: "runs",
      scope: "1 = 1",
      bucketSeconds: 600,
      maxBuckets: 48,
      grouped: false,
    });
    expect(sql).toContain("triggered_at");
  });

  it("handles runs.failure_rate ratio template with task scope", () => {
    const sql = buildBucketedQuery({
      template:
        "SELECT countIf(status IN ('CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT', 'COMPLETED_WITH_ERRORS')) / count() * 100 FROM runs WHERE {{scope}} AND is_finished = 1",
      table: "runs",
      scope: "task_identifier = 'demo-task'",
      bucketSeconds: 600,
      maxBuckets: 48,
      grouped: false,
    });
    expect(sql).toContain("triggered_at");
    expect(sql).toContain("task_identifier = 'demo-task' AND is_finished = 1");
    expect(sql).toContain("countIf");
    expect(sql).not.toContain("created_at");
  });

  it("fails if bucket count is uncapped", () => {
    const sql = buildBucketedQuery({
      template: "SELECT count() FROM runs WHERE {{scope}}",
      table: "runs",
      scope: "1 = 1",
      bucketSeconds: 300,
      maxBuckets: 48,
      grouped: false,
    });
    expect(sql).toContain("LIMIT");
    const limitMatch = sql.match(/LIMIT (\d+)/);
    expect(limitMatch).toBeTruthy();
    expect(Number(limitMatch![1])).toBeLessThanOrEqual(48 * 5);
  });

  const failureRate = {
    template:
      "SELECT countIf(status = 'CRASHED') / count() * 100 FROM runs WHERE {{scope}} AND is_finished = 1",
    table: "runs",
    scope: "1 = 1",
    maxBuckets: 48,
    grouped: false,
  };

  it("fails when the 5m evaluation sub-buckets are dropped from a 4h bucket", () => {
    const sql = buildBucketedQuery({
      ...failureRate,
      bucketSeconds: 14400,
      evalWindow: { seconds: 300, operator: ">" },
    });
    expect(sql).toMatch(
      /^SELECT toStartOfInterval\(sub_bucket, toIntervalSecond\(14400\)\) AS bucket, max\(sub_value\) AS value FROM \(SELECT toStartOfInterval\(triggered_at, toIntervalSecond\(300\)\) AS sub_bucket, countIf\(.* AS sub_value FROM runs WHERE .* GROUP BY sub_bucket\) GROUP BY bucket ORDER BY bucket DESC LIMIT 48$/
    );
  });

  it("fails when a < condition does not take the min sub-bucket", () => {
    const sql = buildBucketedQuery({
      ...failureRate,
      bucketSeconds: 14400,
      evalWindow: { seconds: 300, operator: "<" },
    });
    expect(sql).toContain("min(sub_value) AS value");
    expect(sql).not.toContain("max(sub_value)");
  });

  it("fails when nesting is forced for a bucket no wider than the window", () => {
    const plain = buildBucketedQuery({ ...failureRate, bucketSeconds: 300 });
    expect(
      buildBucketedQuery({
        ...failureRate,
        bucketSeconds: 300,
        evalWindow: { seconds: 300, operator: ">" },
      })
    ).toBe(plain);
    expect(plain).not.toContain("sub_bucket");
  });

  it("fails when keyed series lose the per-key worst sub-bucket", () => {
    const sql = buildBucketedQuery({
      template:
        "SELECT queue, max(max_queued) FROM concurrency_metrics WHERE {{scope}} GROUP BY queue",
      table: "concurrency_metrics",
      scope: "1 = 1",
      bucketSeconds: 14400,
      maxBuckets: 48,
      grouped: true,
      evalWindow: { seconds: 300, operator: ">" },
    });
    expect(sql).toContain("GROUP BY sub_bucket, key) GROUP BY bucket, key");
    expect(sql).toMatch(/LIMIT 240$/);
  });

  it("fails when sub-buckets straddle a bucket that is not a multiple of the window", () => {
    const sql = buildBucketedQuery({
      ...failureRate,
      bucketSeconds: 13200,
      evalWindow: { seconds: 900, operator: ">" },
    });
    expect(sql).toContain("toStartOfInterval(sub_bucket, toIntervalSecond(13500)) AS bucket");
    expect(sql).toContain("toStartOfInterval(triggered_at, toIntervalSecond(900)) AS sub_bucket");
  });
});

describe("fillMetricBuckets", () => {
  it("fills gaps with zero values", () => {
    const sinceMs = Date.parse("2026-01-01T00:00:00Z");
    const nowMs = Date.parse("2026-01-01T02:00:00Z");
    const sparse: MetricSeriesPoint[] = [{ bucket: Date.parse("2026-01-01T01:00:00Z"), value: 42 }];
    const result = fillMetricBuckets(sparse, sinceMs, nowMs, 3600);
    expect(result.length).toBe(2);
    expect(result[0]!.value).toBe(0);
    expect(result[1]!.value).toBe(42);
  });

  it("drops the empty bucket containing now", () => {
    const sinceMs = Date.parse("2026-01-01T00:00:00Z");
    const nowMs = Date.parse("2026-01-01T02:30:00Z");
    const sparse: MetricSeriesPoint[] = [
      { bucket: Date.parse("2026-01-01T01:00:00Z"), value: 218 },
    ];
    const result = fillMetricBuckets(sparse, sinceMs, nowMs, 3600);
    expect(result.map((p) => p.bucket)).toEqual([
      Date.parse("2026-01-01T00:00:00Z"),
      Date.parse("2026-01-01T01:00:00Z"),
    ]);
    expect(result[result.length - 1]!.value).toBe(218);
  });

  it("fills gaps with null when gapValue is null", () => {
    const sinceMs = Date.parse("2026-01-01T00:00:00Z");
    const nowMs = Date.parse("2026-01-01T03:30:00Z");
    const sparse: MetricSeriesPoint[] = [
      { bucket: Date.parse("2026-01-01T00:00:00Z"), value: 30 },
      { bucket: Date.parse("2026-01-01T03:00:00Z"), value: 40 },
    ];
    const result = fillMetricBuckets(sparse, sinceMs, nowMs, 3600, null);
    expect(result.map((p) => p.value)).toEqual([30, null, null, 40]);
  });

  it("caps at 48 buckets", () => {
    const sinceMs = Date.parse("2026-01-01T00:00:00Z");
    const nowMs = Date.parse("2026-01-04T00:00:00Z");
    const result = fillMetricBuckets([], sinceMs, nowMs, 3600);
    expect(result.length).toBe(48);
  });

  it("anchors to the most recent buckets when window exceeds MAX_BUCKETS", () => {
    const nowMs = Date.parse("2026-01-01T24:00:00Z");
    const sinceMs = Date.parse("2026-01-01T00:00:00Z");
    const recentBucket = nowMs - 300_000;
    const sparse: MetricSeriesPoint[] = [{ bucket: recentBucket, value: 42 }];
    const result = fillMetricBuckets(sparse, sinceMs, nowMs, 600);
    expect(result.length).toBe(48);
    expect(result.some((p) => p.value === 42)).toBe(true);
  });

  it("maps epoch-aligned CH rows to non-zero values in the last 48 buckets (300s over 24h)", () => {
    const bucketMs = 300_000;
    const nowMs = Date.now();
    const sinceMs = nowMs - 24 * 3600_000;
    const aligned = Math.floor((nowMs - 600_000) / bucketMs) * bucketMs;
    const sparse: MetricSeriesPoint[] = [{ bucket: aligned, value: 42 }];
    const result = fillMetricBuckets(sparse, sinceMs, nowMs, 300);
    expect(result.some((p) => p.value === 42)).toBe(true);
  });

  it("includes the current (partial) bucket as the last point", () => {
    const bucketMs = 300_000;
    const nowMs = Date.now();
    const sinceMs = nowMs - 24 * 3600_000;
    const currentAligned = Math.floor(nowMs / bucketMs) * bucketMs;
    const sparse: MetricSeriesPoint[] = [{ bucket: currentAligned, value: 99 }];
    const result = fillMetricBuckets(sparse, sinceMs, nowMs, 300);
    expect(result[result.length - 1]!.value).toBe(99);
    expect(result[result.length - 1]!.bucket).toBe(currentAligned);
  });

  it("maps rows at aligned and unaligned timestamps with ORDER BY DESC LIMIT semantics", () => {
    const bucketMs = 600_000;
    const nowMs = Date.now();
    const sinceMs = nowMs - 24 * 3600_000;
    const aligned1 = Math.floor((nowMs - 600_000) / bucketMs) * bucketMs;
    const aligned2 = Math.floor((nowMs - 1200_000) / bucketMs) * bucketMs;
    const sparse: MetricSeriesPoint[] = [
      { bucket: aligned1, value: 10 },
      { bucket: aligned2, value: 20 },
    ];
    const result = fillMetricBuckets(sparse, sinceMs, nowMs, 600);
    expect(result.length).toBe(48);
    const nonZero = result.filter((p) => (p.value ?? 0) > 0);
    expect(nonZero.length).toBe(2);
    expect(nonZero.some((p) => p.value === 10)).toBe(true);
    expect(nonZero.some((p) => p.value === 20)).toBe(true);
  });

  it("last-write-wins when multiple rows map to the same bucket", () => {
    const sinceMs = Date.parse("2026-01-01T00:00:00Z");
    const nowMs = Date.parse("2026-01-01T02:00:00Z");
    const sparse: MetricSeriesPoint[] = [
      { bucket: sinceMs, value: 10 },
      { bucket: sinceMs + 100, value: 20 },
    ];
    const result = fillMetricBuckets(sparse, sinceMs, nowMs, 3600);
    expect(result[0]!.value).toBe(20);
  });
});

describe("getMetricSeries", () => {
  afterEach(() => clearMetricCache());

  const capability: AlertCapability = {
    key: "queue.depth",
    area: "queues",
    signal: "metric",
    allowedKinds: ["threshold"],
    binding: {
      type: "query",
      template:
        "SELECT queue, max(max_queued) FROM concurrency_metrics WHERE {{scope}} GROUP BY queue",
      table: "concurrency_metrics",
      minCadenceSec: 300,
    },
    minCadenceSec: 300,
    title: "Queue depth",
    unit: "count",
    surfaces: ["alerts_page"],
    curated: true,
    freshness: "gauge",
    allowedScopes: ["queue"],
  };

  const params: AlertParams = {
    environmentId: "env_1",
    scope: { type: "queue", queue: "test-queue" },
  };

  it("returns cached result on second call", async () => {
    let callCount = 0;
    const runner: QueryRowRunner = async () => {
      callCount++;
      return [{ bucket: "2026-01-01T00:00:00Z", value: 10 }];
    };

    const input = {
      alertId: "alert_cache_test",
      capability,
      params,
      organizationId: "org_1",
      projectId: "proj_1",
    };

    await getMetricSeries(input, runner);
    await getMetricSeries(input, runner);
    expect(callCount).toBe(1);
  });

  it("resolves condition params and declared defaults in the template", async () => {
    const queries: string[] = [];
    const runner: QueryRowRunner = async (query) => {
      queries.push(query);
      return [{ bucket: "2026-01-01T00:00:00Z", value: 1 }];
    };
    const paramCapability: AlertCapability = {
      ...capability,
      binding: {
        ...capability.binding,
        template:
          "SELECT count() > {{p.failureRatePct}} OR max(x) > {{p.durationP95Ms}} FROM runs WHERE {{scope}}",
        table: "runs",
        params: [
          { key: "failureRatePct", default: 5 },
          { key: "durationP95Ms", default: 1000 },
        ],
      },
    } as AlertCapability;

    const result = await getMetricSeries(
      {
        alertId: "alert_params",
        capability: paramCapability,
        params,
        condition: { kind: "state", stateKey: "s", params: { failureRatePct: 42 } },
        organizationId: "org_1",
        projectId: "proj_1",
      },
      runner
    );

    expect(result.get("__agg__")!.length).toBeGreaterThan(0);
    expect(queries[0]).toContain("> 42");
    expect(queries[0]).toContain("> 1000");
    expect(queries[0]).not.toContain("{{");
  });

  it("fails when the threshold window does not shape the query or the cache key", async () => {
    const queries: string[] = [];
    const runner: QueryRowRunner = async (query) => {
      queries.push(query);
      return [];
    };
    const until = new Date("2026-01-08T00:00:00Z");
    const base = {
      alertId: "alert_eval_window",
      capability,
      params,
      organizationId: "org_1",
      projectId: "proj_1",
      window: { since: new Date(until.getTime() - 7 * 86400_000), until },
    };
    await getMetricSeries(
      { ...base, condition: { kind: "threshold", operator: ">", value: 20, windowSec: 300 } },
      runner
    );
    await getMetricSeries(
      { ...base, condition: { kind: "threshold", operator: "<", value: 20, windowSec: 300 } },
      runner
    );
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("toIntervalSecond(300)) AS sub_bucket");
    expect(queries[0]).toContain("max(sub_value)");
    expect(queries[1]).not.toContain("sub_bucket");
  });

  it("fails when an empty window inside a bucket does not read 0 for a < count alert", async () => {
    const queries: { query: string; range: { from: string; to: string } }[] = [];
    const bucketMs = 13200_000;
    const until = new Date("2026-01-08T00:05:00Z");
    const since = new Date(until.getTime() - 7 * 86400_000);
    const inner = Math.ceil(since.getTime() / bucketMs) * bucketMs + 5 * bucketMs;
    const runner: QueryRowRunner = async (query, _ctx, range) => {
      queries.push({ query, range });
      return [
        { bucket: new Date(inner).toISOString(), value: 5, windows: 21 },
        { bucket: new Date(inner + bucketMs).toISOString(), value: 5, windows: 22 },
      ];
    };
    const result = await getMetricSeries(
      {
        alertId: "alert_volume_below",
        capability: getCapability("runs.volume")!,
        params,
        condition: { kind: "threshold", operator: "<", value: 1, windowSec: 600 },
        organizationId: "org_1",
        projectId: "proj_1",
        window: { since, until },
      },
      runner
    );
    const points = result.get("__agg__")!;
    expect(points.find((p) => p.bucket === inner)?.value).toBe(0);
    expect(points.find((p) => p.bucket === inner + bucketMs)?.value).toBe(5);
    expect(queries[0]!.query).toContain("min(sub_value) AS value, count() AS windows");
    expect(Date.parse(queries[0]!.range.to) % 600_000).toBe(0);
    expect(queries[0]!.range.to).toBe("2026-01-08T00:00:00.000Z");
  });

  it("fails when a < alert on a non-count metric is nested", async () => {
    const queries: string[] = [];
    const runner: QueryRowRunner = async (query) => {
      queries.push(query);
      return [];
    };
    const until = new Date("2026-01-08T00:00:00Z");
    await getMetricSeries(
      {
        alertId: "alert_gauge_below",
        capability: { ...capability, freshness: "gauge" },
        params,
        condition: { kind: "threshold", operator: "<", value: 1, windowSec: 300 },
        organizationId: "org_1",
        projectId: "proj_1",
        window: { since: new Date(until.getTime() - 7 * 86400_000), until },
      },
      runner
    );
    expect(queries[0]).not.toContain("sub_bucket");
  });

  it("fails when failure-rate windows below the evaluator's min volume are kept", async () => {
    const queries: string[] = [];
    const runner: QueryRowRunner = async (query) => {
      queries.push(query);
      return [];
    };
    const until = new Date("2026-01-08T00:00:00Z");
    for (const key of ["runs.failure_rate", "runs.volume"]) {
      await getMetricSeries(
        {
          alertId: `alert_${key}`,
          capability: getCapability(key)!,
          params,
          condition: { kind: "threshold", operator: ">", value: 20, windowSec: 600 },
          organizationId: "org_1",
          projectId: "proj_1",
          window: { since: new Date(until.getTime() - 7 * 86400_000), until },
        },
        runner
      );
    }
    expect(queries[0]).toContain("GROUP BY sub_bucket HAVING count() >= 10)");
    expect(queries[1]).toContain("sub_bucket");
    expect(queries[1]).not.toContain("HAVING");
  });

  it("fails when the configured failure-rate min volume is ignored", async () => {
    const queries: string[] = [];
    const runner: QueryRowRunner = async (query) => {
      queries.push(query);
      return [];
    };
    const until = new Date("2026-01-08T00:00:00Z");
    await getMetricSeries(
      {
        alertId: "alert_min_volume",
        capability: getCapability("runs.failure_rate")!,
        params,
        condition: { kind: "threshold", operator: ">", value: 20, windowSec: 600 },
        organizationId: "org_1",
        projectId: "proj_1",
        window: { since: new Date(until.getTime() - 7 * 86400_000), until },
        failureRateMinVolume: 25,
      },
      runner
    );
    expect(queries[0]).toContain("HAVING count() >= 25)");
  });

  it("returns empty map for non-query bindings", async () => {
    const reportCapability = {
      ...capability,
      binding: { type: "unknown" as const },
    };

    const runner: QueryRowRunner = async () => [];
    const result = await getMetricSeries(
      {
        alertId: "alert_report",
        capability: reportCapability as any,
        params,
        organizationId: "org_1",
        projectId: "proj_1",
      },
      runner
    );
    expect(result.size).toBe(0);
  });

  it("returns __agg__ series for single-scope queries", async () => {
    const runner: QueryRowRunner = async () => [
      { bucket: "2026-01-01T00:00:00Z", value: 5 },
      { bucket: "2026-01-01T00:05:00Z", value: 10 },
    ];

    const result = await getMetricSeries(
      {
        alertId: "alert_single",
        capability,
        params,
        organizationId: "org_1",
        projectId: "proj_1",
      },
      runner
    );
    expect(result.has("__agg__")).toBe(true);
    expect(result.get("__agg__")!.length).toBeGreaterThan(0);
  });

  it("breaks gauge and rate gaps with null and zero-fills count gaps", async () => {
    const until = new Date("2026-01-01T12:05:00Z");
    const window = { since: new Date(until.getTime() - 3600_000), until };
    const runner: QueryRowRunner = async () => [
      { bucket: "2026-01-01T11:20:00Z", value: 30 },
      { bucket: "2026-01-01T11:50:00Z", value: 40 },
    ];
    const runParams: AlertParams = {
      environmentId: "env_1",
      scope: { type: "task", taskIdentifier: "demo-task" },
    };
    const base = {
      area: "runs" as const,
      signal: "metric" as const,
      allowedKinds: ["threshold" as const],
      minCadenceSec: 600,
      surfaces: ["alerts_page" as const],
      curated: true,
      allowedScopes: ["task" as const],
    };
    const gauge: AlertCapability = {
      ...base,
      key: "runs.duration_p95",
      title: "Duration (p95)",
      unit: "duration_ms",
      freshness: "gauge",
      binding: {
        type: "query",
        template: "SELECT quantile(0.95)(execution_duration) FROM runs WHERE {{scope}}",
        table: "runs",
        minCadenceSec: 600,
      },
    };
    const count: AlertCapability = {
      ...gauge,
      key: "runs.volume",
      title: "Run volume",
      unit: "count",
      freshness: "counter",
      binding: { ...gauge.binding, template: "SELECT count() FROM runs WHERE {{scope}}" },
    };
    const rate: AlertCapability = {
      ...count,
      key: "runs.failure_rate",
      title: "Failure rate",
      unit: "percent",
    };
    const input = {
      params: runParams,
      organizationId: "org_1",
      projectId: "proj_1",
      window,
    };

    const gaugeSeries = (
      await getMetricSeries({ ...input, alertId: "alert_gauge_gap", capability: gauge }, runner)
    ).get("__agg__")!;
    const countSeries = (
      await getMetricSeries({ ...input, alertId: "alert_count_gap", capability: count }, runner)
    ).get("__agg__")!;

    const rateSeries = (
      await getMetricSeries({ ...input, alertId: "alert_rate_gap", capability: rate }, runner)
    ).get("__agg__")!;

    expect(gaugeSeries.slice(-4).map((p) => p.value)).toEqual([30, null, null, 40]);
    expect(rateSeries.slice(-4).map((p) => p.value)).toEqual([30, null, null, 40]);
    expect(countSeries.slice(-4).map((p) => p.value)).toEqual([30, 0, 0, 40]);
  });

  it("aligns grouped series when only some keys have a now-bucket row", async () => {
    const until = new Date("2026-01-01T12:02:30Z");
    const window = { since: new Date(until.getTime() - 3600_000), until };
    const runner: QueryRowRunner = async (query) =>
      query.includes("key")
        ? [
            { bucket: "2026-01-01T12:00:00Z", key: "queue-a", value: 5 },
            { bucket: "2026-01-01T11:30:00Z", key: "queue-a", value: 3 },
            { bucket: "2026-01-01T11:30:00Z", key: "queue-b", value: 4 },
          ]
        : [{ bucket: "2026-01-01T11:30:00Z", value: 7 }];

    const result = await getMetricSeries(
      {
        alertId: "alert_grouped_align",
        capability,
        params: { environmentId: "env_1", scope: { type: "queuePattern", pattern: "queue-*" } },
        organizationId: "org_1",
        projectId: "proj_1",
        window,
      },
      runner
    );
    const buckets = (key: string) => result.get(key)!.map((p) => p.bucket);
    expect(buckets("queue-a")).toEqual(buckets("queue-b"));
    expect(buckets("__agg__")).toEqual(buckets("queue-a"));
    expect(buckets("queue-a").slice(-1)[0]).toBe(Date.parse("2026-01-01T12:00:00Z"));
  });

  it("returns empty __agg__ when there are no rows", async () => {
    const runner: QueryRowRunner = async () => [];
    const result = await getMetricSeries(
      {
        alertId: "alert_no_rows",
        capability,
        params,
        organizationId: "org_1",
        projectId: "proj_1",
      },
      runner
    );
    expect(result.get("__agg__")).toEqual([]);
  });

  it("zero-fills the whole window for counter capabilities with no rows", async () => {
    const runner: QueryRowRunner = async () => [];
    const result = await getMetricSeries(
      {
        alertId: "alert_silent",
        capability: { ...capability, freshness: "counter" },
        params,
        organizationId: "org_1",
        projectId: "proj_1",
      },
      runner
    );
    const agg = result.get("__agg__")!;
    expect(agg.length).toBeGreaterThan(0);
    expect(agg.every((p) => p.value === 0)).toBe(true);
  });

  it("scans only maxBuckets x bucket size", async () => {
    let span = 0;
    const runner: QueryRowRunner = async (_q, _c, range) => {
      span = Date.parse(range.to) - Date.parse(range.from);
      return [];
    };
    await getMetricSeries(
      {
        alertId: "alert_span",
        capability: { ...capability, freshness: "counter" },
        params,
        organizationId: "org_1",
        projectId: "proj_1",
        maxBuckets: 24,
      },
      runner
    );
    expect(span).toBe(24 * 600 * 1000);
  });

  it("caps the series at maxBuckets", async () => {
    const runner: QueryRowRunner = async () => [];
    const series = (maxBuckets?: number) =>
      getMetricSeries(
        {
          alertId: `alert_cap_${maxBuckets}`,
          capability: { ...capability, freshness: "counter" },
          params,
          organizationId: "org_1",
          projectId: "proj_1",
          maxBuckets,
        },
        runner
      ).then((m) => m.get("__agg__")!);
    const half = await series(24);
    const full = await series(48);
    expect(half[1]!.bucket - half[0]!.bucket).toBe(2 * (full[1]!.bucket - full[0]!.bucket));
    expect(
      half[half.length - 1]!.bucket - half[0]!.bucket + (half[1]!.bucket - half[0]!.bucket)
    ).toBe(full[full.length - 1]!.bucket - full[0]!.bucket + (full[1]!.bucket - full[0]!.bucket));
    expect(await series(24)).toHaveLength(24);
    expect(await series()).toHaveLength(48);
  });

  it("returns top 5 keys from a 7-key fixture with complete buckets", async () => {
    const now = new Date();
    const recentBucket = new Date(now.getTime() - 600_000).toISOString();
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 7; i++) {
      rows.push({ bucket: recentBucket, key: `queue-${i}`, value: (7 - i) * 100 });
    }
    const runner: QueryRowRunner = async () => rows;
    const allParams: AlertParams = { environmentId: "env_1", scope: { type: "all" } };

    const result = await getMetricSeries(
      {
        alertId: "alert_grouped_7",
        capability,
        params: allParams,
        organizationId: "org_1",
        projectId: "proj_1",
        windowHours: 1,
      },
      runner
    );
    const namedKeys = Array.from(result.keys()).filter((k) => k !== "__other__" && k !== "__agg__");
    expect(namedKeys.length).toBe(5);
    expect(namedKeys).toContain("queue-0");
    expect(namedKeys).toContain("queue-4");
    expect(namedKeys).not.toContain("queue-5");
    expect(namedKeys).not.toContain("queue-6");
    for (const key of namedKeys) {
      expect(result.get(key)!.some((p) => (p.value ?? 0) > 0)).toBe(true);
    }
  });

  it("computes __agg__ via a separate ungrouped SQL query for scope-all", async () => {
    const now = new Date();
    const bucket1 = new Date(now.getTime() - 600_000).toISOString();
    const bucket2 = new Date(now.getTime() - 300_000).toISOString();
    let callCount = 0;
    const runner: QueryRowRunner = async (query) => {
      callCount++;
      if (query.includes("key")) {
        return [
          { bucket: bucket1, key: "worker-1", value: 10 },
          { bucket: bucket1, key: "worker-2", value: 20 },
          { bucket: bucket2, key: "worker-1", value: 15 },
          { bucket: bucket2, key: "worker-2", value: 25 },
        ];
      }
      return [
        { bucket: bucket1, value: 20 },
        { bucket: bucket2, value: 25 },
      ];
    };
    const allParams: AlertParams = { environmentId: "env_1", scope: { type: "all" } };

    const result = await getMetricSeries(
      {
        alertId: "alert_agg_sql",
        capability,
        params: allParams,
        organizationId: "org_1",
        projectId: "proj_1",
        windowHours: 1,
      },
      runner
    );
    expect(callCount).toBe(2);
    expect(result.has("__agg__")).toBe(true);
    const agg = result.get("__agg__")!;
    const nonZero = agg.filter((p) => (p.value ?? 0) > 0);
    expect(nonZero.length).toBeGreaterThanOrEqual(2);
  });

  it("returns __agg__ for scope-all counter with no GROUP BY in template (runs.created)", async () => {
    const absenceCapability: AlertCapability = {
      ...capability,
      key: "runs.created",
      freshness: "counter",
      binding: {
        type: "query",
        template: "SELECT count() FROM runs WHERE {{scope}}",
        table: "runs",
        minCadenceSec: 600,
      },
    };
    const now = new Date();
    const bucket = new Date(now.getTime() - 1200_000).toISOString();
    const runner: QueryRowRunner = async () => [{ bucket, value: 42 }];
    const allParams: AlertParams = { environmentId: "env_1", scope: { type: "all" } };

    const result = await getMetricSeries(
      {
        alertId: "alert_absence_counter",
        capability: absenceCapability,
        params: allParams,
        organizationId: "org_1",
        projectId: "proj_1",
        windowHours: 1,
      },
      runner
    );
    expect(result.has("__agg__")).toBe(true);
    const agg = result.get("__agg__")!;
    expect(agg.some((p) => p.value === 42)).toBe(true);
  });

  it("evicts oldest entry when cache exceeds max size", async () => {
    const runner: QueryRowRunner = async () => [{ bucket: "2026-01-01T00:00:00Z", value: 1 }];
    for (let i = 0; i < 502; i++) {
      await getMetricSeries(
        {
          alertId: `alert_evict_${i}`,
          capability,
          params,
          organizationId: "org_1",
          projectId: "proj_1",
        },
        runner
      );
    }
    expect(metricCacheSize()).toBeLessThanOrEqual(501);
  });

  it("uses query runner not event buckets for query-bound capabilities", async () => {
    let queryCalled = false;
    const runner: QueryRowRunner = async () => {
      queryCalled = true;
      return [{ bucket: "2026-01-01T00:00:00Z", value: 42 }];
    };

    await getMetricSeries(
      {
        alertId: "alert_metric_path",
        capability,
        params,
        organizationId: "org_1",
        projectId: "proj_1",
      },
      runner
    );
    expect(queryCalled).toBe(true);
  });
});

describe("mapEventsToTimeline", () => {
  it("maps raised/recovered/resolved/stopped/expired events and sorts by time", () => {
    const events = [
      { type: "resolved", at: new Date("2026-01-01T03:00:00Z") },
      { type: "raised", at: new Date("2026-01-01T01:00:00Z") },
      { type: "recovered", at: new Date("2026-01-01T02:00:00Z") },
      { type: "legacy", at: new Date("2026-01-01T01:30:00Z") },
      { type: "expired", at: new Date("2026-01-01T04:00:00Z") },
    ];
    const timeline = mapEventsToTimeline(events);
    expect(timeline.length).toBe(4);
    expect(timeline[0]!.type).toBe("raised");
    expect(timeline[1]!.type).toBe("recovered");
    expect(timeline[2]!.type).toBe("resolved");
    expect(timeline[3]!.type).toBe("expired");
  });

  it("filters out non-lifecycle event types", () => {
    const events = [{ type: "legacy", at: new Date("2026-01-01T01:00:00Z") }];
    expect(mapEventsToTimeline(events).length).toBe(0);
  });

  it("returns empty array for empty input", () => {
    expect(mapEventsToTimeline([]).length).toBe(0);
  });
});

describe("pickThresholdSeries", () => {
  const agg: MetricSeriesPoint[] = [{ bucket: 1000, value: 42 }];
  const keyed: MetricSeriesPoint[] = [{ bucket: 1000, value: 42, key: "demo-task" }];

  it("single task scope returns the __agg__ series as non-empty for a real runtime shape", () => {
    const map = new Map([
      ["__agg__", agg],
      ["demo-task", keyed],
    ]);
    const result = pickThresholdSeries(map, "task");
    expect(result.multi).toBe(false);
    if (!result.multi) {
      expect(result.series).toBe(agg);
      expect(result.series.length).toBeGreaterThan(0);
    }
  });

  it("single queue scope returns only the aggregate", () => {
    const map = new Map([
      ["__agg__", agg],
      ["worker-1", keyed],
    ]);
    const result = pickThresholdSeries(map, "queue");
    expect(result.multi).toBe(false);
  });

  it("all scope returns the __agg__ series as a single line", () => {
    const map = new Map([
      ["__agg__", agg],
      ["demo-task", keyed],
    ]);
    const result = pickThresholdSeries(map, "all");
    expect(result.multi).toBe(false);
    if (!result.multi) {
      expect(result.series).toBe(agg);
    }
  });

  it("queuePattern scope returns multi", () => {
    const map = new Map([["__agg__", agg]]);
    const result = pickThresholdSeries(map, "queuePattern");
    expect(result.multi).toBe(true);
  });

  it("excludes __agg__ but keeps __other__ via visibleSeriesKeys", () => {
    const map = new Map<string, MetricSeriesPoint[]>([
      ["__agg__", agg],
      ["__other__", agg],
      ["worker-1", keyed],
      ["worker-2", keyed],
    ]);
    const keys = visibleSeriesKeys(map);
    expect(keys).toContain("worker-1");
    expect(keys).toContain("worker-2");
    expect(keys).toContain("__other__");
    expect(keys).not.toContain("__agg__");
  });
});

describe("quietWindowBounds", () => {
  const bucketMs = 600_000;
  const series: MetricSeriesPoint[] = Array.from({ length: 10 }, (_, i) => ({
    bucket: 1000 + i * bucketMs,
    value: i < 7 ? 5 : 0,
  }));

  it("returns x1/x2 covering the last quietWindowSec of the series", () => {
    const bounds = quietWindowBounds(series, 1800);
    expect(bounds).not.toBeNull();
    const last = series[series.length - 1]!.bucket;
    expect(bounds!.x2).toBe(last);
    expect(bounds!.x1).toBe(last - 1800 * 1000);
  });

  it("returns null when quietWindowSec is undefined", () => {
    expect(quietWindowBounds(series, undefined)).toBeNull();
  });

  it("returns null for empty series", () => {
    expect(quietWindowBounds([], 1800)).toBeNull();
  });

  it("clamps x1 to the first bucket when the window exceeds the series range", () => {
    const short: MetricSeriesPoint[] = [{ bucket: 1000, value: 1 }];
    const bounds = quietWindowBounds(short, 99999);
    expect(bounds).not.toBeNull();
    expect(bounds!.x1).toBe(1000);
    expect(bounds!.x2).toBe(1000);
  });
});

describe("buildHealthBands", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-09-18T12:00:00Z");

  it("marks degraded buckets from events with warn/crit findings", () => {
    const events = [
      {
        at: new Date(now - 2 * DAY_MS),
        facts: {
          projection: "all",
          findings: [{ type: "flow", severity: "warn", reason: "slow" }],
        },
      },
    ];
    const bands = buildHealthBands(events, now);
    expect(bands.length).toBeGreaterThan(0);
    const degradedBands = bands.filter((b) => b.degraded === 1);
    expect(degradedBands.length).toBeGreaterThan(0);
  });

  it("marks healthy buckets after a recovered event", () => {
    const events = [
      {
        at: new Date(now - 3 * DAY_MS),
        facts: {
          projection: "all",
          findings: [{ type: "flow", severity: "warn", reason: "slow" }],
        },
      },
      {
        at: new Date(now - 1 * DAY_MS),
        facts: {
          projection: "all",
          findings: [{ type: "flow", severity: "ok", reason: "recovered" }],
        },
      },
    ];
    const bands = buildHealthBands(events, now);
    const lastBand = bands[bands.length - 1]!;
    expect(lastBand.healthy).toBe(1);
    expect(lastBand.degraded).toBeNull();
  });

  describe("window with more transitions than the old 50-event cap", () => {
    const HOUR_MS = 60 * 60 * 1000;
    const startMs = now - 7 * DAY_MS;
    const warn = {
      projection: "all",
      findings: [{ type: "flow", severity: "warn", reason: "slow" }],
    };
    const ok = { projection: "all", findings: [{ type: "flow", severity: "ok", reason: "ok" }] };
    const seed = { at: new Date(startMs - 3 * DAY_MS), facts: ok };
    const inWindow = Array.from({ length: 60 }, (_, i) => ({
      at: new Date(startMs + i * HOUR_MS + 1),
      facts: i % 2 === 0 ? warn : ok,
    }));

    it("shows early degraded buckets when every in-window event is passed with the seed", () => {
      const bands = buildHealthBands([seed, ...inWindow], now, startMs, HOUR_MS * 4);
      expect(bands[0]!.degraded).toBe(1);
      expect(bands[1]!.degraded).toBe(1);
    });

    it("renders the uncovered span as unknown when only the newest 50 are known", () => {
      const bands = buildHealthBands(inWindow.slice(-50), now, startMs, HOUR_MS * 4);
      expect(bands[0]!.unknown).toBe(1);
      expect(bands[1]!.unknown).toBe(1);
    });

    it("hides the early degraded buckets with the old newest-50 plus seed shape", () => {
      const bands = buildHealthBands([seed, ...inWindow.slice(-50)], now, startMs, HOUR_MS * 4);
      expect(bands[0]!.degraded).toBeNull();
      expect(bands[0]!.healthy).toBe(1);
    });
  });

  it("returns unknown for buckets before any event", () => {
    const events = [
      {
        at: new Date(now - 1 * DAY_MS),
        facts: { projection: "all", findings: [{ type: "flow", severity: "ok", reason: "good" }] },
      },
    ];
    const bands = buildHealthBands(events, now);
    expect(bands[0]!.unknown).toBe(1);
  });

  it("returns empty for no events", () => {
    const bands = buildHealthBands([], now);
    const allUnknown = bands.every((b) => b.unknown === 1);
    expect(allUnknown).toBe(true);
  });

  it("treats crit severity as degraded", () => {
    const events = [
      {
        at: new Date(now - 2 * DAY_MS),
        facts: {
          projection: "all",
          findings: [{ type: "execution", severity: "crit", reason: "timeout" }],
        },
      },
    ];
    const bands = buildHealthBands(events, now);
    const degradedBands = bands.filter((b) => b.degraded === 1);
    expect(degradedBands.length).toBeGreaterThan(0);
  });

  it("seeds initial status from the latest event before the 7-day window", () => {
    const events = [
      {
        at: new Date(now - 10 * DAY_MS),
        facts: {
          projection: "all",
          findings: [{ type: "flow", severity: "warn", reason: "slow" }],
        },
      },
    ];
    const bands = buildHealthBands(events, now);
    const allDegraded = bands.every((b) => b.degraded === 1);
    expect(allDegraded).toBe(true);
  });
});

describe("alertLifetimeWindow", () => {
  const now = new Date("2026-03-01T00:00:00Z");
  const createdAt = new Date("2026-02-01T00:00:00Z");
  const stoppedAt = new Date("2026-02-19T00:00:00Z");
  const base = {
    createdAt,
    resolvedAt: null,
    stoppedAt: null,
    expiresAt: null,
  };

  it("keeps the default window for active alerts", () => {
    expect(alertLifetimeWindow({ ...base, lifecycle: "active" }, now)).toBeUndefined();
  });

  it("spans createdAt..stoppedAt for a stopped alert", () => {
    expect(alertLifetimeWindow({ ...base, lifecycle: "stopped", stoppedAt }, now)).toEqual({
      since: createdAt,
      until: stoppedAt,
    });
  });

  it("ends at resolvedAt or expiresAt for completed and expired alerts", () => {
    const resolvedAt = new Date("2026-02-10T00:00:00Z");
    expect(
      alertLifetimeWindow({ ...base, lifecycle: "completed", resolvedAt }, now)?.until
    ).toEqual(resolvedAt);
    const expiresAt = new Date("2026-02-12T00:00:00Z");
    expect(alertLifetimeWindow({ ...base, lifecycle: "expired", expiresAt }, now)?.until).toEqual(
      expiresAt
    );
  });
});

describe("getMetricSeries with a lifetime window", () => {
  afterEach(() => clearMetricCache());

  it("does not reuse a now-anchored cache entry for a windowed call", async () => {
    const ranges: Array<{ from: string; to: string }> = [];
    const runner: QueryRowRunner = async (_query, _scope, r) => {
      ranges.push(r as { from: string; to: string });
      return [];
    };
    const input = {
      alertId: "alert_cache_window",
      capability: {
        key: "queue.depth",
        area: "queues",
        signal: "metric",
        allowedKinds: ["threshold"],
        binding: {
          type: "query",
          template: "SELECT max(max_queued) FROM concurrency_metrics WHERE {{scope}}",
          table: "concurrency_metrics",
          minCadenceSec: 300,
        },
        minCadenceSec: 300,
        title: "Queue depth",
        unit: "count",
        surfaces: ["alerts_page"],
        curated: true,
        freshness: "gauge",
        allowedScopes: ["queue"],
      } satisfies AlertCapability,
      params: { environmentId: "env_1", scope: { type: "queue", queue: "q" } } as AlertParams,
      organizationId: "org_1",
      projectId: "proj_1",
    };
    const window = {
      since: new Date("2026-01-01T00:00:00Z"),
      until: new Date("2026-01-05T00:00:00Z"),
    };

    await getMetricSeries(input, runner);
    await getMetricSeries({ ...input, window }, runner);

    expect(ranges).toHaveLength(2);
    expect(ranges[1]).toEqual({
      from: window.since.toISOString(),
      to: window.until.toISOString(),
    });
  });

  it("queries and buckets createdAt..stoppedAt for an alert stopped 10 days ago", async () => {
    const now = Date.now();
    const createdAt = new Date(now - 14 * 24 * 3600 * 1000);
    const stoppedAt = new Date(now - 10 * 24 * 3600 * 1000);
    const window = alertLifetimeWindow(
      {
        lifecycle: "stopped",
        createdAt,
        resolvedAt: null,
        stoppedAt,
        expiresAt: null,
      },
      new Date(now)
    )!;

    let range: { from: string; to: string } | undefined;
    const runner: QueryRowRunner = async (_query, _scope, r) => {
      range = r as { from: string; to: string };
      return [{ bucket: new Date(stoppedAt.getTime() - 3600 * 1000).toISOString(), value: 7 }];
    };

    const result = await getMetricSeries(
      {
        alertId: "alert_lifetime",
        capability: {
          key: "queue.depth",
          area: "queues",
          signal: "metric",
          allowedKinds: ["threshold"],
          binding: {
            type: "query",
            template: "SELECT max(max_queued) FROM concurrency_metrics WHERE {{scope}}",
            table: "concurrency_metrics",
            minCadenceSec: 300,
          },
          minCadenceSec: 300,
          title: "Queue depth",
          unit: "count",
          surfaces: ["alerts_page"],
          curated: true,
          freshness: "gauge",
          allowedScopes: ["queue"],
        },
        params: { environmentId: "env_1", scope: { type: "queue", queue: "q" } },
        organizationId: "org_1",
        projectId: "proj_1",
        window,
      },
      runner
    );

    expect(range).toEqual({ from: createdAt.toISOString(), to: stoppedAt.toISOString() });
    const points = result.get("__agg__")!;
    const bucketMs = points[1]!.bucket - points[0]!.bucket;
    expect(points.length).toBeLessThanOrEqual(48);
    expect(points[0]!.bucket).toBeLessThanOrEqual(createdAt.getTime() + bucketMs);
    expect(points[points.length - 1]!.bucket).toBeLessThanOrEqual(stoppedAt.getTime());
    expect(points[points.length - 1]!.bucket).toBeGreaterThan(stoppedAt.getTime() - 2 * bucketMs);
    expect(points.some((p) => p.value === 7)).toBe(true);
  });
});

describe("getMetricSeries null readings", () => {
  afterEach(() => clearMetricCache());

  it("emits no points for rows with a null value", async () => {
    const runner: QueryRowRunner = async () => [
      { bucket: "2026-01-01T00:00:00Z", value: null },
      { bucket: "2026-01-01T00:05:00Z", value: null },
    ];
    const result = await getMetricSeries(
      {
        alertId: "alert_null_rows",
        capability: {
          key: "queue.depth",
          area: "queues",
          signal: "metric",
          allowedKinds: ["threshold"],
          binding: {
            type: "query",
            template: "SELECT max(max_queued) FROM concurrency_metrics WHERE {{scope}}",
            table: "concurrency_metrics",
            minCadenceSec: 300,
          },
          minCadenceSec: 300,
          title: "Queue depth",
          unit: "count",
          surfaces: ["alerts_page"],
          curated: true,
          freshness: "gauge",
          allowedScopes: ["queue"],
        },
        params: { environmentId: "env_1", scope: { type: "queue", queue: "q" } },
        organizationId: "org_1",
        projectId: "proj_1",
      },
      runner
    );
    expect(result.get("__agg__")).toEqual([]);
  });
});

describe("buildHealthBands with a start", () => {
  it("starts at the given start and stays within the default bucket count", () => {
    const now = Date.UTC(2026, 1, 1);
    const start = now - 30 * 24 * 3600 * 1000;
    const bands = buildHealthBands([], now, start);
    expect(bands[0]!.bucket).toBe(start);
    expect(bands.length).toBeLessThanOrEqual(42);
    expect(bands[bands.length - 1]!.bucket).toBeLessThan(now);
  });
});

describe("getMetricSeries with a series template", () => {
  afterEach(() => clearMetricCache());

  const window = {
    since: new Date("2026-01-01T00:00:00Z"),
    until: new Date("2026-01-01T04:00:00Z"),
  };
  const errorGroupParams: AlertParams = {
    environmentId: "env_1",
    scope: { type: "errorGroup", taskIdentifier: "my-task", fingerprint: "fp1" },
  };

  async function seriesQuery(capability: AlertCapability, params: AlertParams) {
    const queries: string[] = [];
    const runner: QueryRowRunner = async (query) => {
      queries.push(query);
      return [{ bucket: "2026-01-01T01:00:00Z", value: 3 }];
    };
    const result = await getMetricSeries(
      {
        alertId: `alert_${capability.key}`,
        capability,
        params,
        condition: { kind: "occurrence" },
        organizationId: "org_1",
        projectId: "proj_1",
        window,
      },
      runner
    );
    return { query: queries[0]!, queries, result };
  }

  it("buckets errors.occurred_again by minute from the series template", async () => {
    const { query, queries } = await seriesQuery(
      getCapability("errors.occurred_again")!,
      errorGroupParams
    );

    expect(queries).toHaveLength(1);
    expect(query).toMatch(
      /^SELECT toStartOfInterval\(minute, toIntervalSecond\(\d+\)\) AS bucket, sum\(count\) AS value FROM error_occurrences WHERE /
    );
    expect(query).toMatch(/GROUP BY bucket ORDER BY bucket DESC LIMIT 48$/);
    expect(query).not.toContain("minute >=");
  });

  it("buckets errors.new by the group first_seen", async () => {
    const { query } = await seriesQuery(getCapability("errors.new")!, {
      environmentId: "env_1",
      scope: { type: "all" },
    });

    expect(query).toMatch(
      /^SELECT toStartOfInterval\(group_first_seen, toIntervalSecond\(\d+\)\) AS bucket, count\(\) AS value FROM \(SELECT /
    );
    expect(query).toMatch(
      /HAVING group_first_seen >= '[^']+' AND group_first_seen < '[^']+'\) GROUP BY bucket/
    );
  });

  it("fills ctx.checkpoint with the window start and fills gaps with 0", async () => {
    const base = getCapability("errors.occurred_again")!;
    const capability: AlertCapability = {
      ...base,
      binding: {
        ...base.binding,
        seriesTemplate:
          "SELECT minute AS bucket, sum(count) AS occurrences FROM error_occurrences WHERE {{scope}} AND minute >= {{ctx.checkpoint}} GROUP BY bucket ORDER BY bucket",
      },
    };
    const { query, result } = await seriesQuery(capability, errorGroupParams);

    expect(query).toContain("minute >= '2026-01-01 00:00:00'");
    const points = result.get("__agg__")!;
    expect(points.length).toBeGreaterThan(1);
    expect(points.filter((p) => p.value === 0)).toHaveLength(points.length - 1);
    expect(points.find((p) => p.value === 3)).toBeDefined();
  });

  it("keeps the main-template query when the binding has no series template", async () => {
    const base = getCapability("errors.occurred_again")!;
    const capability: AlertCapability = {
      ...base,
      binding: {
        type: "query",
        template: "SELECT count() FROM runs WHERE {{scope}}",
        table: "runs",
        minCadenceSec: 300,
      },
    };
    const { query } = await seriesQuery(capability, errorGroupParams);

    expect(query).toContain("toStartOfInterval(triggered_at");
    expect(query).toContain("count() AS value FROM runs WHERE");
  });
});

describe("planHealthChartEvents", () => {
  const seed = { id: "seed" };
  const make = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}` }));
  const cap = 5;

  it("keeps the seed and healthySince below the cap", () => {
    const events = make(3);
    expect(planHealthChartEvents({ seed, events, healthySince: 42, cap })).toEqual({
      events: [seed, ...events],
      healthySince: 42,
    });
  });

  it("keeps the seed and healthySince at exactly the cap", () => {
    const events = make(cap);
    expect(planHealthChartEvents({ seed, events, healthySince: 42, cap })).toEqual({
      events: [seed, ...events],
      healthySince: 42,
    });
  });

  it("drops the seed, the oldest row and healthySince past the cap", () => {
    const events = make(cap + 1);
    expect(planHealthChartEvents({ seed, events, healthySince: 42, cap })).toEqual({
      events: events.slice(1),
      healthySince: undefined,
    });
  });
});
