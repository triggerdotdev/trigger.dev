import { getCapability, type AlertParams } from "@internal/alert-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "~/services/logger.server";
import { healthQueryTerms, percentOfThreshold } from "~/components/alerts/alertSeriesTypes";
import { clearMetricCache } from "./alertSeries.server";
import type { QueryRowRunner } from "./evaluators/queryEvaluator.server";
import { getHealthQuerySeries, silenceSeries, worstGroupQuery } from "./healthQuerySeries.server";

afterEach(() => clearMetricCache());

const templateOf = (key: string) => getCapability(key)!.binding.template!;
const keysOf = (template: string) => healthQueryTerms(template).lines.map((t) => t.paramKey);

describe("percentOfThreshold", () => {
  it("fails when the value is not divided by the threshold", () => {
    const [point, gap] = percentOfThreshold(
      [
        { bucket: 1, value: 5 },
        { bucket: 2, value: null },
      ],
      10
    );
    expect(point!.value).toBe(50);
    expect(gap!.value).toBeNull();
  });
});

describe("healthQueryTerms", () => {
  it("fails when flow drops the backlog max or keeps the stall term", () => {
    const { lines } = healthQueryTerms(templateOf("health.flow"));
    expect(lines).toEqual([
      {
        paramKey: "schedulingDelayMs",
        groupBy: "queue",
        template:
          "SELECT quantilesMerge(0.95)(wait_quantiles)[1] FROM concurrency_metrics WHERE {{scope}}",
      },
      {
        paramKey: "backlogCount",
        groupBy: "queue",
        template: "SELECT max(max_queued) FROM concurrency_metrics WHERE {{scope}}",
      },
    ]);
  });

  it("fails when an execution ratio or percentile is dropped", () => {
    const { lines } = healthQueryTerms(templateOf("health.execution"));
    expect(lines.map((t) => [t.paramKey, t.groupBy])).toEqual([
      ["failureRatePct", null],
      ["durationP95Ms", null],
    ]);
    expect(lines[0]!.template).toMatch(/^SELECT countIf\(.*\) \* 100 \/ if\(.*\) FROM runs WHERE/);
  });

  it("fails when liveness is not plotted from the latest run", () => {
    expect(healthQueryTerms(templateOf("health.liveness"))).toEqual({
      lines: [
        {
          paramKey: "silenceSec",
          groupBy: null,
          lastRun: true,
          template: "SELECT toUnixTimestamp(max(triggered_at)) FROM runs WHERE {{scope}}",
        },
      ],
    });
  });

  it("fails when health.all does not compose the three component templates", () => {
    const all = getCapability("health.all")!.binding;
    expect(all.template).toBeUndefined();
    expect(all.compositeOf!.flatMap((key) => keysOf(templateOf(key)))).toEqual([
      "schedulingDelayMs",
      "backlogCount",
      "failureRatePct",
      "durationP95Ms",
      "silenceSec",
    ]);
  });

  it("fails when a non > {{p.*}} comparison is mis-parsed into a line", () => {
    for (const select of [
      "a >= {{p.x}}",
      "a < {{p.x}}",
      "a > 5",
      "b > 0 AND c > {{p.x}}",
      "a = {{p.x}}",
    ]) {
      const { lines } = healthQueryTerms(`SELECT ${select} FROM runs WHERE {{scope}}`);
      expect(lines).toEqual([]);
    }
  });
});

describe("getHealthQuerySeries", () => {
  const params: AlertParams = { environmentId: "env_1", scope: { type: "all" } } as AlertParams;
  const window = {
    since: new Date("2026-01-01T00:00:00Z"),
    until: new Date("2026-01-01T06:00:00Z"),
  };
  const input = (overrides: Record<string, unknown> = {}) => ({
    alertId: "alert_health",
    capability: getCapability("health.all")!,
    params,
    condition: { kind: "state", stateKey: "health", params: { failureRatePct: 25 } },
    organizationId: "org_1",
    projectId: "proj_1",
    window,
    ...overrides,
  });

  it("fails when the condition params are dropped for the default thresholds", async () => {
    const runner: QueryRowRunner = async () => [{ bucket: "2026-01-01T05:00:00Z", value: 50 }];
    const { series } = await getHealthQuerySeries(input(), runner);
    expect(series.map((s) => s.key)).toEqual([
      "schedulingDelayMs",
      "backlogCount",
      "failureRatePct",
      "durationP95Ms",
      "silenceSec",
    ]);
    const failure = series.find((s) => s.key === "failureRatePct")!;
    expect(failure.label).toBe("Failure rate");
    expect(failure.threshold).toBe(25);
    expect(failure.points.find((p) => p.value !== null)?.value).toBe(200);
  });

  it("fails when the selected components are ignored", async () => {
    const queries: string[] = [];
    const runner: QueryRowRunner = async (query) => {
      queries.push(query);
      return [{ bucket: "2026-01-01T05:00:00Z", value: 1 }];
    };
    const { series } = await getHealthQuerySeries(
      input({
        condition: { kind: "state", stateKey: "health", components: ["health.execution"] },
      }),
      runner
    );
    expect(series.map((s) => s.key)).toEqual(["failureRatePct", "durationP95Ms"]);
    expect(queries.some((q) => q.includes("concurrency_metrics"))).toBe(false);
  });

  it("fails when terms run in parallel or one failure drops every line", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const runner: QueryRowRunner = async () => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (calls === 2) throw new Error("Concurrency limit exceeded");
      return [{ bucket: "2026-01-01T05:00:00Z", value: 1 }];
    };
    const { series } = await getHealthQuerySeries(input(), runner);
    expect(maxInFlight).toBe(1);
    expect(series.map((s) => s.key)).toEqual([
      "schedulingDelayMs",
      "failureRatePct",
      "durationP95Ms",
      "silenceSec",
    ]);
  });

  it("fails when bad params escape instead of yielding no lines", async () => {
    let calls = 0;
    const runner: QueryRowRunner = async () => {
      calls++;
      return [];
    };
    await expect(
      getHealthQuerySeries(input({ params: { scope: "nope" } }), runner)
    ).resolves.toEqual({ series: [] });
    expect(calls).toBe(0);
  });

  it("fails when health lines with 300s and 600s windows use different bucket grids", async () => {
    const until = new Date("2026-01-08T00:00:00Z");
    const runner: QueryRowRunner = async () => [{ bucket: "2026-01-08T00:00:00Z", value: 1 }];
    const { series } = await getHealthQuerySeries(
      input({ window: { since: new Date(until.getTime() - 7 * 86400_000), until } }),
      runner
    );
    expect(series.length).toBe(5);
    const grids = series.map((s) => s.points.map((p) => p.bucket).join(","));
    expect(grids[0]!.length).toBeGreaterThan(0);
    expect(new Set(grids).size).toBe(1);
  });

  const rejection = () =>
    Object.assign(new Error("concurrency"), { __queryConcurrencyRejection: true });

  it("fails when a line is not retried once after a concurrency rejection", async () => {
    let calls = 0;
    const runner: QueryRowRunner = async () => {
      calls++;
      if (calls === 1) throw rejection();
      return [{ bucket: "2026-01-01T05:00:00Z", value: 1 }];
    };
    const { series } = await getHealthQuerySeries(input(), runner);
    expect(series.map((s) => s.key)).toEqual([
      "schedulingDelayMs",
      "backlogCount",
      "failureRatePct",
      "durationP95Ms",
      "silenceSec",
    ]);
  });

  it("fails when a line rejected twice is kept or not logged", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const runner: QueryRowRunner = async () => {
      calls++;
      if (calls <= 2) throw rejection();
      return [{ bucket: "2026-01-01T05:00:00Z", value: 1 }];
    };
    const { series } = await getHealthQuerySeries(input(), runner);
    expect(series.map((s) => s.key)).toEqual([
      "backlogCount",
      "failureRatePct",
      "durationP95Ms",
      "silenceSec",
    ]);
    expect(warn).toHaveBeenCalledWith(
      "alerts.detail.health_line_failed",
      expect.objectContaining({ paramKey: "schedulingDelayMs" })
    );
    warn.mockRestore();
  });

  it("fails when the flow line loses the per-queue max", async () => {
    const queries: string[] = [];
    const runner: QueryRowRunner = async (query) => {
      queries.push(query);
      return [];
    };
    await getHealthQuerySeries(input(), runner);
    const term = healthQueryTerms(templateOf("health.flow")).lines[0]!;
    const sql = worstGroupQuery(
      { ...term, groupBy: "queue" },
      "concurrency_metrics",
      params,
      { schedulingDelayMs: 30000 },
      600,
      37,
      { seconds: 300, operator: ">" }
    );
    expect(queries[0]).toBe(sql);
    expect(sql).toMatch(
      /^SELECT toStartOfInterval\(sub_bucket, toIntervalSecond\(600\)\) AS bucket, max\(sub_value\) AS value FROM \(SELECT toStartOfInterval\(bucket_start, toIntervalSecond\(300\)\) AS sub_bucket, quantilesMerge\(0\.95\)\(wait_quantiles\)\[1\] AS sub_value FROM concurrency_metrics WHERE .* GROUP BY sub_bucket, queue\) GROUP BY bucket ORDER BY bucket DESC LIMIT 37$/
    );
    expect(
      worstGroupQuery(
        { ...term, groupBy: "queue" },
        "concurrency_metrics",
        params,
        { schedulingDelayMs: 30000 },
        300,
        37,
        { seconds: 300, operator: ">" }
      )
    ).toContain(
      "toIntervalSecond(300)) AS sub_bucket, quantilesMerge(0.95)(wait_quantiles)[1] AS sub_value FROM concurrency_metrics WHERE 1 = 1 GROUP BY sub_bucket, queue) GROUP BY bucket"
    );
  });
});

describe("silenceSeries", () => {
  it("fails when silence is not measured from the latest run to each bucket end", () => {
    const since = new Date("2026-01-01T00:00:00Z");
    const until = new Date("2026-01-01T03:00:00Z");
    const h = 3600_000;
    const lastRun = since.getTime() + 1.5 * h;
    const points = [0, 1, 2].map((i) => ({
      bucket: since.getTime() + i * h,
      value: i === 1 ? lastRun / 1000 : null,
    }));
    expect(silenceSeries(points, 3600, { since, until }).map((p) => p.value)).toEqual([
      null,
      1800,
      5400,
    ]);
    expect(
      silenceSeries(points, 3600, { since, until }, since.getTime() / 1000 - 7200).map(
        (p) => p.value
      )
    ).toEqual([10800, 1800, 5400]);
    expect(silenceSeries([], 3600, { since, until }).length).toBeGreaterThan(0);
  });
});
