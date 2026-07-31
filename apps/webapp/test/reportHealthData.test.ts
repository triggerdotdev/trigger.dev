import { describe, expect, it } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  type HealthDeps,
  type HealthQueryRunner,
  loadHealthInput,
} from "~/presenters/v3/reports/health/health-data";

/**
 * Exercises `loadHealthInput`'s ORCHESTRATION through its query seam (`HealthDeps`):
 * source selection, snapshot fallback (empty + throw), dlq parsing, window-from-timeRange.
 * The runner is injected at the IO boundary — SQL/TRQL translation and CH aggregation are
 * tested by the query service and the `@internal/clickhouse` MV tests.
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
  dlqTotal?: Rows;
  worst?: Rows;
  liveWindowMin?: number;
  pendingNow?: number;
  throwOnEnv?: boolean;
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
    if (isEnv && opts.throwOnEnv) throw new Error("env_metrics unavailable");
    if (query.includes("dlq_total")) return wrap(opts.dlqTotal);
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
        dlqTotal: [{ dlq_total: 0 }],
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
        dlqTotal: [],
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

  it("env_metrics query throws -> snapshot fallback, never a 500 (bug-2 guard)", async () => {
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        runsSeries: [{ t: "a", triggered: 10, completed: 8, start_latency_p95: 3000, failures: 0 }],
        throwOnEnv: true,
      })
    );

    expect(input.flowSource).toBe("snapshot+runs");
    expect(input.pending.estimated).toBe(true);
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
        dlqTotal: [{ dlq_total: 3 }],
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
    // ~60 min from the row timestamp, NOT ~0 from timeRange.to
    expect(input.liveness.telemetryAgeMs).toBeGreaterThan(50 * 60_000);
  });

  it("terminal runs (failed/canceled) do not accumulate as snapshot backlog", async () => {
    const input = await loadHealthInput(
      fakeEnv,
      "1h",
      NOW,
      makeDeps({
        runs: RUNS_SCALAR,
        // every triggered run also FINISHED this bucket (some failed) -> proxy stays flat at 0
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
  });
});
