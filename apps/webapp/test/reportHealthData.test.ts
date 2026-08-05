import { describe, expect, it } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  type HealthDeps,
  type HealthQueryRunner,
  loadHealthInput,
} from "~/presenters/v3/reports/health/health-data";
import { interpret } from "~/presenters/v3/reports/health/health";
import { renderReportMarkdown } from "~/presenters/v3/reports/renderMarkdown";

/**
 * Exercises `loadHealthInput`'s orchestration through its query seam (`HealthDeps`): source
 * selection, snapshot fallback, dlq parsing, window-from-timeRange. The runner is injected at the
 * IO boundary; SQL translation and ClickHouse aggregation are covered elsewhere.
 */

const NOW = new Date("2026-07-22T12:00:00.000Z");

const fakeEnv = {
  id: "env_1",
  slug: "prod",
  organization: { id: "org_1" },
  project: { id: "proj_1" },
} as unknown as AuthenticatedEnvironment;

type Rows = Record<string, unknown>[];

/** Canned rows per query kind; the resolved timeRange is keyed off the period (7d = baseline). */
function makeDeps(opts: {
  runs: Rows;
  runsSeries?: Rows;
  envSeries?: Rows;
  envScalar?: Rows;
  queueTotals?: Rows;
  worst?: Rows;
  liveWindowMin?: number;
  pendingNow?: number;
  /** Error the env_metrics queries throw (true = a generic, non-rollout failure). */
  throwOnEnv?: boolean | Error;
  redisThrows?: boolean;
}): HealthDeps {
  const rangeFor = (period: string) => {
    const min = period === "7d" ? 7 * 1440 : (opts.liveWindowMin ?? 60);
    return { from: new Date(NOW.getTime() - min * 60_000), to: NOW };
  };
  const runQuery: HealthQueryRunner = async (_env, query, period) => {
    const timeRange = rangeFor(period);
    const wrap = (rows: Rows = []) => ({ rows, timeRange });
    const isEnv = query.includes("FROM env_metrics");
    if (isEnv && opts.throwOnEnv) {
      throw opts.throwOnEnv instanceof Error
        ? opts.throwOnEnv
        : new Error("env_metrics unavailable");
    }
    if (query.includes("dlq_total")) return wrap(opts.queueTotals);
    if (isEnv && query.includes("timeBucket")) return wrap(opts.envSeries);
    if (isEnv) return wrap(opts.envScalar ?? [{}]);
    if (query.includes("FROM queue_metrics")) return wrap(opts.worst);
    if (query.includes("task_identifier")) return wrap([]);
    if (query.includes("FROM runs") && query.includes("timeBucket")) return wrap(opts.runsSeries);
    return wrap(opts.runs); // runs scalar (live + baseline)
  };
  const lengthOfEnvQueue = opts.redisThrows
    ? async () => {
        throw new Error("redis unavailable");
      }
    : async () => opts.pendingNow ?? 0;
  return { runQuery, lengthOfEnvQueue };
}

const RUNS_SCALAR: Rows = [
  {
    start_latency_p95: 7000,
    dur_p95: 1000,
    failures: 1,
    completed: 100,
    triggered: 120,
    last_activity: "2026-07-22 11:59:58",
  },
];

describe("loadHealthInput — orchestration (query seam)", () => {
  it("measured path: queue_metrics source, real pending, parsed dlq, window from timeRange", async () => {
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        envSeries: [
          { t: "a", queued: 100, running: 50, throttled: 0, wait_p95: 5000 },
          { t: "b", queued: 300, running: 60, throttled: 1, wait_p95: 9000 },
        ],
        envScalar: [{ wait_p95: 9000, avg_queued: 200, env_limit: 100 }],
        queueTotals: [{ dlq_total: 0, total_queued: 100 }],
        worst: [
          { name: "email-sends", latest_queued: 82 },
          { name: "other", latest_queued: 18 },
        ],
        pendingNow: 1910,
        liveWindowMin: 60,
      })
    );

    expect(input.flowSource).toBe("queue_metrics_v1");
    expect(input.pending.estimated).toBe(false);
    expect(input.pending.now).toBe(1910);
    expect(input.flowEvidence.dlqDelta).toBe(0);
    expect(input.flowEvidence.worstQueue).toEqual({ name: "email-sends", share: 0.82 });
    expect(input.windowMinutes).toBe(60);
    expect(input.throughput.triggeredPerMin).toBeCloseTo(120 / 60);
  });

  it("dlq best-effort query returns nothing -> dlqDelta is null (unmeasured, no false 'nothing dead-lettered')", async () => {
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        envSeries: [{ t: "a", queued: 10, running: 5, throttled: 0, wait_p95: 100 }],
        envScalar: [{ wait_p95: 100, avg_queued: 8, env_limit: 100 }],
        queueTotals: [],
      })
    );

    expect(input.flowSource).toBe("queue_metrics_v1");
    expect(input.flowEvidence.dlqDelta).toBeNull();
  });

  it("no measured env rows -> snapshot fallback (estimated backlog)", async () => {
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        runsSeries: [{ t: "a", triggered: 10, completed: 8, start_latency_p95: 3000, failures: 0 }],
        envSeries: [], // pipeline hasn't populated env_metrics for this env yet
      })
    );

    expect(input.flowSource).toBe("snapshot+runs");
    expect(input.pending.estimated).toBe(true);
  });

  it("a ROLLOUT error (env_metrics not there yet) -> clean snapshot fallback, depth still measured", async () => {
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        runsSeries: [{ t: "a", triggered: 10, completed: 8, start_latency_p95: 3000, failures: 0 }],
        // The shape ClickHouse returns before the table exists.
        throwOnEnv: new Error(
          "Unable to query clickhouse: Code: 60. DB::Exception: Table trigger_dev.env_metrics_v1 does not exist. (UNKNOWN_TABLE)"
        ),
        pendingNow: 12,
      })
    );

    expect(input.flowSource).toBe("snapshot+runs");
    expect(input.pending.estimated).toBe(true);
    expect(input.pending.now).toBe(12); // Redis measured it, so the depth is trustworthy
    expect(input.pending.availability).toBe("measured");
  });

  it("an UNEXPECTED env_metrics failure + Redis down never becomes 'backlog 0'", async () => {
    // Falling back to the snapshot on any error let a failed Redis call read as depth 0, which
    // produced a confident, actionable green flow verdict during two outages.
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        runsSeries: [{ t: "a", triggered: 10, completed: 8, start_latency_p95: 3000, failures: 0 }],
        throwOnEnv: new Error("Unable to query clickhouse: Code: 241. Memory limit exceeded"),
        redisThrows: true,
      })
    );

    expect(input.pending.availability).toBe("unknown"); // couldn't measure ≠ measured zero

    const vm = interpret(input);
    const flow = vm.findings.find((f) => f.type === "flow")!;
    expect(flow.reason).toBe("flow_unmeasured");
    expect(flow.severity).not.toBe("crit"); // not a fabricated alarm either
    expect(flow.recommendation).toBeUndefined(); // nothing actionable off a failed measurement
    // Untrustworthy twice over: no depth, and no telemetry heartbeat on the snapshot path.
    expect(vm.facts).toMatchObject({ trustworthy: false, telemetry: "none" });
    expect(vm.footer).toEqual([{ code: "nothing_to_do" }]);

    const md = renderReportMarkdown(vm);
    expect(md).not.toContain("pending 0");
    expect(md).not.toContain("🟢 Flow healthy");
  });

  it("snapshot path with Redis down marks the depth unknown, not zero", async () => {
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        runsSeries: [
          { t: "a", triggered: 100, completed: 10, finished: 10, start_latency_p95: 3000 },
        ],
        envSeries: [], // pipeline hasn't reached this env
        redisThrows: true,
      })
    );

    expect(input.flowSource).toBe("snapshot+runs");
    expect(input.pending.availability).toBe("unknown");
    expect(input.pending.now).toBe(90); // last proxy point, explicitly estimated — never a bare 0
    expect(
      interpret(input).findings.find((f) => f.type === "flow")!.recommendation
    ).toBeUndefined();
  });

  it("windowMinutes comes from the resolved (clipped) timeRange, not the period string", async () => {
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        envSeries: [{ t: "a", queued: 10, running: 5, throttled: 0, wait_p95: 100 }],
        envScalar: [{ wait_p95: 100, avg_queued: 8, env_limit: 100 }],
        queueTotals: [{ dlq_total: 3 }],
        liveWindowMin: 45,
      })
    );

    expect(input.windowMinutes).toBe(45);
    expect(input.flowEvidence.dlqDelta).toBe(3);
  });

  it("telemetry age is measured from the newest ROW, not the query window end (= NOW)", async () => {
    const OLD = "2026-07-22 11:00:00"; // 60 min before NOW, though the query window ends at NOW
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: [{ ...RUNS_SCALAR[0], last_activity: OLD }],
        envSeries: [{ t: "a", queued: 10, running: 5, throttled: 0, wait_p95: 100 }],
        envScalar: [{ wait_p95: 100, avg_queued: 8, env_limit: 100, last_bucket: OLD }],
      })
    );
    // ~60 min from the row timestamp, not ~0 from timeRange.to
    expect(input.liveness.telemetryAgeMs).toBeGreaterThan(50 * 60_000);
  });

  it("terminal runs (failed/canceled) do not accumulate as snapshot backlog", async () => {
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        // every triggered run also finished this bucket (some failed), so the proxy stays at 0
        runsSeries: [
          {
            t: "a",
            triggered: 50,
            completed: 30,
            finished: 50,
            start_latency_p95: 1000,
            failures: 20,
          },
          {
            t: "b",
            triggered: 40,
            completed: 25,
            finished: 40,
            start_latency_p95: 1000,
            failures: 15,
          },
        ],
        envSeries: [], // force the snapshot path
      })
    );
    expect(input.flowSource).toBe("snapshot+runs");
    expect(Math.max(...input.pending.series)).toBe(0);
  });

  it("Redis rejection falls back to the latest measured queued, not a confident 0", async () => {
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        envSeries: [
          { t: "a", queued: 10, running: 5, throttled: 0, wait_p95: 100 },
          { t: "b", queued: 900, running: 5, throttled: 0, wait_p95: 100 },
        ],
        envScalar: [{ wait_p95: 100, avg_queued: 8, env_limit: 100 }],
        redisThrows: true,
      })
    );
    expect(input.flowSource).toBe("queue_metrics_v1");
    expect(input.pending.now).toBe(900);
    expect(input.pending.availability).toBe("measured"); // env_metrics measured it, so it stands
  });

  it("worst-queue share divides by the env-wide total, not just the top 20 rows", async () => {
    // 100 queues, the worst holds 40 of a true total of 200 (20%). Summing only the 20 returned
    // rows gives 40/80, enough to cross the attribution threshold and name a queue falsely.
    const worst: Rows = [
      { name: "email-sends", latest_queued: 40 },
      ...Array.from({ length: 19 }, (_, i) => ({ name: `q${i}`, latest_queued: 40 / 19 })),
    ];
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        envSeries: [{ t: "a", queued: 200, running: 50, throttled: 0, wait_p95: 100 }],
        envScalar: [{ wait_p95: 100, avg_queued: 200, env_limit: 100 }],
        queueTotals: [{ dlq_total: 0, total_queued: 200 }],
        worst,
      })
    );

    expect(input.flowEvidence.worstQueue).toEqual({ name: "email-sends", share: 0.2 });
    // ...and 20% is below the attribution threshold, so no queue gets named.
    const flow = interpret(input).findings.find((f) => f.type === "flow")!;
    expect(flow.attribution).toBeUndefined();
  });

  it("no queue totals -> no attribution (a share needs a denominator)", async () => {
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        envSeries: [{ t: "a", queued: 200, running: 50, throttled: 0, wait_p95: 100 }],
        envScalar: [{ wait_p95: 100, avg_queued: 200, env_limit: 100 }],
        queueTotals: [],
        worst: [{ name: "email-sends", latest_queued: 400 }],
      })
    );
    expect(input.flowEvidence.worstQueue).toBeNull();
  });

  it("carries bucket cadence + timestamps so a gappy series can't read as a full window", async () => {
    // A 60-minute window of env_metrics buckets at the schema's cadence, but only two rows arrived.
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        envSeries: [
          { t: "2026-07-22 11:58:00", queued: 100, running: 100, throttled: 0, wait_p95: 100 },
          { t: "2026-07-22 11:59:00", queued: 100, running: 100, throttled: 0, wait_p95: 100 },
        ],
        envScalar: [{ wait_p95: 100, avg_queued: 8, env_limit: 100 }],
        liveWindowMin: 60,
      })
    );

    const sampling = input.flowEvidence.sampling!;
    expect(sampling.bucketMinutes).toBeGreaterThan(0);
    // Far more buckets expected than the two that arrived: the coverage the analyzer needs.
    expect(sampling.expectedBuckets).toBeGreaterThan(10);
    expect(input.flowEvidence.runningBucketsMs).toHaveLength(2);
    // Two pinned samples must not be read as a pinned window.
    const vm = interpret(input);
    expect(vm.findings.find((f) => f.type === "flow")!.reason).not.toBe("env_limit_saturation");
    expect(vm.metrics.find((m) => m.id === "concurrency")!.annotation).toBeUndefined();
  });

  it("a quiet snapshot env with only an old run is not reported as a stale pipeline", async () => {
    // 10-minute-old run, no env_metrics heartbeat. Run activity is not telemetry freshness: an
    // idle env with a healthy pipeline must not be told to "check the control plane".
    const OLD_RUN = "2026-07-22 11:50:00";
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: [{ ...RUNS_SCALAR[0], last_activity: OLD_RUN }],
        runsSeries: [{ t: "a", triggered: 2, completed: 2, finished: 2, start_latency_p95: 1000 }],
        envSeries: [], // no heartbeat on this path
        pendingNow: 0,
      })
    );

    expect(input.liveness.telemetryAgeMs).toBeNull(); // genuinely unknown, not 10 minutes stale

    const vm = interpret(input);
    const liveness = vm.findings.find((f) => f.type === "liveness")!;
    expect(liveness.reason).toBe("freshness_unknown");
    expect(liveness.severity).toBe("ok");
    expect(liveness.recommendation).toBeUndefined(); // no "check control plane"
    expect(vm.footer).not.toEqual([{ code: "check_control_plane", link: "status" }]);
  });

  it("drain rate counts every terminal run: 80 completed + 20 failed vs 100 triggered reads stable", async () => {
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: [
          {
            start_latency_p95: 1000,
            dur_p95: 1000,
            failures: 20 * 60,
            completed: 80 * 60,
            finished: 100 * 60,
            triggered: 100 * 60,
            last_activity: "2026-07-22 11:59:58",
          },
        ],
        envSeries: [{ t: "a", queued: 10, running: 50, throttled: 0, wait_p95: 100 }],
        envScalar: [{ wait_p95: 100, avg_queued: 10, env_limit: 100 }],
        liveWindowMin: 60,
      })
    );

    expect(input.throughput.finishedPerMin).toBeCloseTo(100);
    expect(input.throughput.completedPerMin).toBeCloseTo(80); // execution-side metric, unchanged
    // net = finished minus triggered = 0: the queue is keeping pace, not losing 20/min.
    const throughput = interpret(input).metrics.find((m) => m.id === "throughput")!;
    expect(throughput.value).toBeCloseTo(0);
    expect(throughput.severity).toBe("ok");
  });

  it("a runs row without the finished column falls back to completions, not to a 0 drain rate", async () => {
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR, // no `finished` key
        envSeries: [{ t: "a", queued: 10, running: 5, throttled: 0, wait_p95: 100 }],
        envScalar: [{ wait_p95: 100, avg_queued: 8, env_limit: 100 }],
        liveWindowMin: 60,
      })
    );
    expect(input.throughput.finishedPerMin).toBeCloseTo(100 / 60);
  });
});
