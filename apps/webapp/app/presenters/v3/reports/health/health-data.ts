import { calculateTimeBucketInterval, type TimeBucketInterval } from "@internal/tsql";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { executeQuery, isQueryConcurrencyRejection } from "~/services/queryService.server";
import { envMetricsSchema } from "~/v3/querySchemas";
import { engine } from "~/v3/runEngine.server";
import { HEALTH_THRESHOLDS, type HealthInput } from "./health";

/** User-code failures only. Expired and Canceled are excluded from both sides of the rate. */
const FAILURE_STATUSES = "'Failed','Crashed','System failure','Timed out'";

/** All terminal statuses: a run that reached any of these has left the queue. */
const FINISHED_STATUSES =
  "'Completed','Canceled','Expired','Failed','Crashed','System failure','Timed out'";

/** p95 is index 3 of quantilesTDigestMerge(0.5, 0.9, 0.95, 0.99) (1-based). */
const WAIT_P95 = "quantilesTDigestMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[3]";

const BASELINE_PERIOD = "7d";
const SPARKLINE_BUCKETS = 7;

type Row = Record<string, unknown>;

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : fallback;
}

/** Like `num`, but keeps "no measurement" distinct from a measured 0. */
function optionalNum(value: unknown): number | undefined {
  const n = num(value, NaN);
  return Number.isFinite(n) ? n : undefined;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function resampleSeries(points: number[], target = SPARKLINE_BUCKETS): number[] {
  if (points.length <= target) return points;
  const out: number[] = [];
  const stride = points.length / target;
  for (let i = 0; i < target; i++) {
    const start = Math.floor(i * stride);
    const end = Math.floor((i + 1) * stride);
    const slice = points.slice(start, Math.max(end, start + 1));
    out.push(mean(slice));
  }
  return out;
}

function failureRate(failures: number, completed: number): number {
  const denom = failures + completed;
  return denom === 0 ? 0 : failures / denom;
}

/** Order-preserving. The query service rejects the 4th concurrent query per project. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Max ClickHouse queries in flight. The per-project limit is 3, so this leaves headroom. */
const CH_CONCURRENCY = 2;

// The per-project limit is shared, so concurrent requests can still be rejected. That is retryable.
const CH_REJECTION_RETRIES = 6;
const CH_REJECTION_BACKOFF_MS = 60; // base for exponential "full jitter" backoff
const CH_REJECTION_BACKOFF_CAP_MS = 2000; // ceiling per attempt

function isConcurrencyRejection(error: unknown): boolean {
  // Prefer the query service's stable marker; fall back to message text for other shapes.
  if (isQueryConcurrencyRejection(error)) return true;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "");
  return /concurrency|too many|try again/i.test(message);
}

/** Rows plus the clip-aware time window the query service resolved for this run. */
type QueryResult = { rows: Row[]; timeRange: { from: Date; to: Date } };

export type HealthQueryRunner = (
  env: AuthenticatedEnvironment,
  query: string,
  period: string
) => Promise<QueryResult>;

/** The loader's IO boundary. */
export type HealthDeps = {
  runQuery: HealthQueryRunner;
  lengthOfEnvQueue: (env: AuthenticatedEnvironment) => Promise<number | undefined>;
};

// The 7d baseline is cached per env and query. Only the default runner caches.
const BASELINE_CACHE_TTL_MS = 5 * 60_000;
const baselineCache = new Map<string, { expiresAt: number; result: QueryResult }>();

/** Sweeps expired entries first so envs that stop requesting reports don't linger in memory. */
function cacheBaseline(key: string, result: QueryResult, now: number) {
  for (const [k, v] of baselineCache) {
    if (v.expiresAt <= now) baselineCache.delete(k);
  }
  baselineCache.set(key, { expiresAt: now + BASELINE_CACHE_TTL_MS, result });
}

async function executeReportQuery(
  env: AuthenticatedEnvironment,
  query: string,
  period: string
): Promise<QueryResult> {
  const cacheKey = period === BASELINE_PERIOD ? `${env.id}\u0000${query}` : null;
  if (cacheKey) {
    const hit = baselineCache.get(cacheKey);
    if (hit && Date.now() < hit.expiresAt) return hit.result;
  }
  for (let attempt = 0; ; attempt++) {
    const result = await executeQuery({
      name: "report-health",
      query,
      scope: "environment",
      organizationId: env.organization.id,
      projectId: env.project.id,
      environmentId: env.id,
      period,
      history: { source: "API", skip: true },
    });
    if (result.success) {
      const out = { rows: result.result.rows as Row[], timeRange: result.timeRange };
      if (cacheKey) cacheBaseline(cacheKey, out, Date.now());
      return out;
    }
    // Full-jitter backoff so concurrent report requests don't wake in lockstep and re-collide.
    if (attempt < CH_REJECTION_RETRIES && isConcurrencyRejection(result.error)) {
      const window = Math.min(CH_REJECTION_BACKOFF_CAP_MS, CH_REJECTION_BACKOFF_MS * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * window)));
      continue;
    }
    throw result.error;
  }
}

// executeQuery injects tenant isolation and the time window, so these queries never write WHERE.
function runsScalarQuery(): string {
  return `SELECT
  quantile(0.95)(queued_duration) AS start_latency_p95,
  quantile(0.95)(execution_duration) AS dur_p95,
  countIf(status IN (${FAILURE_STATUSES})) AS failures,
  countIf(status = 'Completed') AS completed,
  countIf(status IN (${FINISHED_STATUSES})) AS finished,
  count() AS triggered,
  max(triggered_at) AS last_activity
FROM runs`;
}

function runsSeriesQuery(): string {
  return `SELECT
  timeBucket() AS t,
  quantile(0.95)(queued_duration) AS start_latency_p95,
  countIf(status IN (${FAILURE_STATUSES})) AS failures,
  countIf(status = 'Completed') AS completed,
  countIf(status IN (${FINISHED_STATUSES})) AS finished,
  count() AS triggered
FROM runs
GROUP BY t
ORDER BY t`;
}

function envSeriesQuery(): string {
  return `SELECT
  timeBucket() AS t,
  max(max_env_queued) AS queued,
  max(max_env_running) AS running,
  sum(throttled_count) AS throttled,
  ${WAIT_P95} AS wait_p95
FROM env_metrics
GROUP BY t
ORDER BY t`;
}

function envScalarQuery(): string {
  return `SELECT
  ${WAIT_P95} AS wait_p95,
  avg(max_env_queued) AS avg_queued,
  max(max_env_limit) AS env_limit,
  max(bucket_start) AS last_bucket
FROM env_metrics`;
}

/**
 * `argMax(max_queued, bucket_start)` is a point-in-time depth, not a peak. These rows stop at 20, so
 * the share's denominator comes from `queueTotalsQuery`.
 */
function queueWorstQuery(): string {
  return `SELECT
  queue AS name,
  argMax(max_queued, bucket_start) AS latest_queued
FROM queue_metrics
GROUP BY queue
ORDER BY latest_queued DESC
LIMIT 20`;
}

/**
 * `dlq_delta` must be merged per queue then summed, never merged across queues. `total_queued` must
 * be computed here, not by summing the top-20 `queueWorstQuery` rows.
 */
function queueTotalsQuery(): string {
  return `SELECT sum(dlq) AS dlq_total, sum(latest_queued) AS total_queued
FROM (
  SELECT
    deltaSumTimestampMerge(dlq_delta) AS dlq,
    argMax(max_queued, bucket_start) AS latest_queued
  FROM queue_metrics
  GROUP BY queue
)`;
}

/** Top failing task. Loaded lazily, only when execution degrades. */
function failureBreakdownQuery(): string {
  return `SELECT
  task_identifier AS task,
  countIf(status IN (${FAILURE_STATUSES})) AS fails
FROM runs
GROUP BY task
ORDER BY fails DESC
LIMIT 10`;
}

const defaultHealthDeps: HealthDeps = {
  runQuery: executeReportQuery,
  lengthOfEnvQueue: (env) => engine.lengthOfEnvQueue(env),
};

/** Never throws. Callers treat no rows as unmeasured rather than as a measured zero. */
async function tryQuery(
  deps: HealthDeps,
  env: AuthenticatedEnvironment,
  query: string,
  period: string
): Promise<QueryResult> {
  try {
    return await deps.runQuery(env, query, period);
  } catch {
    return { rows: [], timeRange: { from: new Date(0), to: new Date(0) } };
  }
}

type FlowData = {
  flowSource: HealthInput["flowSource"];
  pending: HealthInput["pending"];
  startLatency: HealthInput["startLatency"];
  evidence: HealthInput["flowEvidence"];
  /** Epoch ms of the freshest telemetry. Null means no signal, which makes liveness unknown. */
  telemetryLastTs: number | null;
};

const EMPTY_EVIDENCE: HealthInput["flowEvidence"] = {
  runningSeries: [],
  envLimit: 0,
  throttledShare: 0,
  worstQueue: null,
  dlqDelta: null, // snapshot path: dead-letter volume is unmeasured
};

type RunsContext = { liveScalar: Row; liveSeries: Row[]; baselineScalar: Row };

/**
 * "unavailable" is a recognized rollout state, so the next source down is a legitimate substitute.
 * "failed" is anything else and must make the flow verdict unassessable, never fall through to it.
 */
type FlowLoadResult =
  | { status: "ok"; data: FlowData }
  | { status: "unavailable" }
  | { status: "failed"; error: unknown };

interface FlowSource {
  loadFlow(
    env: AuthenticatedEnvironment,
    period: string,
    ctx: RunsContext,
    deps: HealthDeps
  ): Promise<FlowLoadResult>;
}

/**
 * The only failures the measured source may treat as a benign fallback: the object itself does not
 * exist yet, so waiting is correct. Codes 60 (table) and 81 (database). Matched on error text
 * because the client collapses the error into a message.
 *
 * 47 (UNKNOWN_IDENTIFIER) is deliberately absent: the table exists and a column in our own query
 * does not, which is a broken query, not a rollout gap. It must surface as a failed source.
 */
const ROLLOUT_ERROR_PATTERNS = [
  /\bUNKNOWN_(?:TABLE|DATABASE)\b/,
  /\bCode:\s*(?:60|81)\b/,
  /\bTable\b[^.]*\bdoes\s?n?o?t?'?t?\s*exist/i,
  /\bUnknown (?:table|database)\b/i,
];

function isRolloutError(error: unknown): boolean {
  // Prefer a structured code/type if one ever survives the wrapping.
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const code = String(record.code ?? "");
    const type = String(record.type ?? "");
    if (code === "60" || code === "81") return true;
    if (/^UNKNOWN_(TABLE|DATABASE)$/.test(type)) return true;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  return ROLLOUT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/** Measured depth and scheduling-delay p95 from `env_metrics`. Unavailable until it is populated. */
const QueueMetricsSource: FlowSource = {
  async loadFlow(env, period, ctx, deps) {
    try {
      // The rejection must be guarded: if the queries below throw first this is never awaited, and
      // an unhandled Redis rejection would crash the process.
      const pendingNowPromise = deps.lengthOfEnvQueue(env).catch(() => undefined);

      // Every task must return the same shape; a mixed union trips mapWithConcurrency's inference.
      const [seriesResult, liveScalarResult, baselineScalarResult, worstQueueResult, totalsResult] =
        await mapWithConcurrency(
          [
            () => deps.runQuery(env, envSeriesQuery(), period),
            () => deps.runQuery(env, envScalarQuery(), period),
            () => deps.runQuery(env, envScalarQuery(), BASELINE_PERIOD),
            () => tryQuery(deps, env, queueWorstQuery(), period),
            () => tryQuery(deps, env, queueTotalsQuery(), period),
          ],
          CH_CONCURRENCY,
          (task) => task()
        );
      const seriesRows = seriesResult.rows;
      const liveScalarRow = liveScalarResult.rows[0] ?? {};
      const baselineScalarRow = baselineScalarResult.rows[0] ?? {};

      const pendingNow = await pendingNowPromise;

      if (seriesRows.length === 0) {
        return { status: "unavailable" }; // no measured data yet -> snapshot fallback
      }

      // Freshness is the newer of the latest env_metrics bucket and the latest run.
      const telemetryLastTs = freshestTs(liveScalarRow.last_bucket, ctx.liveScalar.last_activity);

      return {
        status: "ok",
        data: buildQueueMetricsFlow({
          series: seriesRows,
          sampling: envSampling(seriesResult.timeRange),
          liveScalar: liveScalarRow,
          baselineScalar: baselineScalarRow,
          worstRows: worstQueueResult.rows,
          totalsRows: totalsResult.rows,
          pendingNow,
          telemetryLastTs,
        }),
      };
    } catch (error) {
      // Only a rollout error is a benign fallback. Anything else must surface as failed.
      if (isRolloutError(error)) return { status: "unavailable" };
      logger.error("report health: measured flow source failed", {
        environmentId: env.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: "failed", error };
    }
  },
};

/** Minutes per env_metrics bucket, matching the interval the query printer emits. */
const INTERVAL_UNIT_MINUTES: Record<TimeBucketInterval["unit"], number> = {
  SECOND: 1 / 60,
  MINUTE: 1,
  HOUR: 60,
  DAY: 1440,
  WEEK: 10_080,
  MONTH: 43_200,
};

/** Derived from the query printer's own thresholds, so "expected" matches what the query emits. */
function envSampling(range: {
  from: Date;
  to: Date;
}): { bucketMinutes: number; expectedBuckets: number } | null {
  const windowMinutes = timeRangeMinutes(range);
  if (windowMinutes === 0) return null;
  const interval = calculateTimeBucketInterval(
    range.from,
    range.to,
    envMetricsSchema.timeBucketThresholds
  );
  const bucketMinutes = interval.value * INTERVAL_UNIT_MINUTES[interval.unit];
  if (!(bucketMinutes > 0)) return null;
  return { bucketMinutes, expectedBuckets: Math.max(1, Math.round(windowMinutes / bucketMinutes)) };
}

function buildQueueMetricsFlow(args: {
  series: Row[];
  sampling: { bucketMinutes: number; expectedBuckets: number } | null;
  liveScalar: Row;
  baselineScalar: Row;
  worstRows: Row[];
  totalsRows: Row[];
  pendingNow: number | undefined;
  telemetryLastTs: number | null;
}): FlowData {
  const { series, sampling, liveScalar, baselineScalar, worstRows, totalsRows } = args;
  const totals = totalsRows[0];
  // Zero means measured none; no rows means unmeasured.
  const dlqDelta = totals !== undefined ? Math.round(num(totals.dlq_total)) : null;

  // Measured against expected buckets when the cadence is known, not against received rows.
  const throttledBuckets = series.filter((r) => num(r.throttled) > 0).length;
  const throttledDenominator = sampling?.expectedBuckets ?? series.length;
  const throttledShare = throttledDenominator > 0 ? throttledBuckets / throttledDenominator : 0;

  // The denominator is the env-wide total, never the sum of these top-20 rows. No total, no share.
  let worstQueue: HealthInput["flowEvidence"]["worstQueue"] = null;
  const totalQueued = totals !== undefined ? num(totals.total_queued) : 0;
  if (worstRows.length > 0 && totalQueued > 0) {
    const worstDepth = num(worstRows[0].latest_queued);
    if (worstDepth > 0) {
      worstQueue = {
        name: String(worstRows[0].name ?? "unknown"),
        share: Math.min(1, worstDepth / totalQueued),
      };
    }
  }

  // Prefer live Redis depth, then the latest measured queued from env_metrics.
  const lastMeasuredQueued = num(series[series.length - 1]?.queued);

  // Only carried when every bucket parsed: a partial set would make "adjacent" meaningless.
  const bucketTimestamps = series.map((r) => parseTimestamp(r.t));
  const runningBucketsMs = bucketTimestamps.every((t): t is number => t !== null)
    ? bucketTimestamps
    : undefined;

  const waitP95 = optionalNum(liveScalar.wait_p95);

  return {
    flowSource: "queue_metrics_v1",
    pending: {
      now: args.pendingNow ?? lastMeasuredQueued,
      normal: Math.round(num(baselineScalar.avg_queued)),
      series: resampleSeries(series.map((r) => num(r.queued))),
      estimated: false, // measured
      availability: "measured",
    },
    startLatency: {
      p95Ms: waitP95 ?? 0,
      normalP95Ms: optionalNum(baselineScalar.wait_p95),
      series: resampleSeries(series.map((r) => num(r.wait_p95))),
      availability: waitP95 === undefined ? "unknown" : "measured",
    },
    evidence: {
      runningSeries: series.map((r) => num(r.running)),
      runningBucketsMs,
      sampling,
      envLimit: num(liveScalar.env_limit),
      throttledShare,
      worstQueue,
      dlqDelta,
    },
    telemetryLastTs: args.telemetryLastTs,
  };
}

/**
 * Fallback: live Redis depth plus a backlog proxy from `runs` (triggered minus finished). The proxy
 * is shape-only: it starts at 0 within the window and can't see backlog that predates it.
 */
const SnapshotFlowSource: FlowSource = {
  async loadFlow(env, _period, ctx, deps) {
    // Last-resort source, so a Redis failure must not break the report.
    const pendingNow = await deps.lengthOfEnvQueue(env).catch(() => undefined);

    // Subtract all terminal runs, or failed and canceled runs linger as phantom backlog.
    let backlog = 0;
    const proxy = ctx.liveSeries.map((r) => {
      backlog = Math.max(0, backlog + num(r.triggered) - num(r.finished));
      return backlog;
    });
    const series = resampleSeries(proxy);
    const startLatencyP95 = optionalNum(ctx.liveScalar.start_latency_p95);

    // Redis is the only depth measurement here, so a failure must not substitute 0. Fall back to the
    // last proxy point and mark the depth unknown.
    const depthUnavailable = pendingNow === undefined;
    const lastProxyPoint = proxy.length > 0 ? proxy[proxy.length - 1] : 0;

    return {
      status: "ok",
      data: {
        flowSource: "snapshot+runs",
        pending: {
          now: pendingNow ?? lastProxyPoint,
          // No 7d pending baseline on this path, so severity falls back to an absolute floor.
          normal: undefined,
          series,
          estimated: true,
          availability: depthUnavailable ? "unknown" : "measured",
        },
        startLatency: {
          p95Ms: startLatencyP95 ?? 0,
          normalP95Ms: optionalNum(ctx.baselineScalar.start_latency_p95),
          series: resampleSeries(ctx.liveSeries.map((r) => num(r.start_latency_p95))),
          availability: startLatencyP95 === undefined ? "unknown" : "measured",
        },
        // No cause-tree evidence; interpret falls back to v1 symptoms.
        evidence: EMPTY_EVIDENCE,
        // This path has no pipeline heartbeat, and run activity is not one.
        telemetryLastTs: null,
      },
    };
  },
};

export async function loadHealthInput(
  env: AuthenticatedEnvironment,
  period: string,
  now: Date = new Date(),
  deps: HealthDeps = defaultHealthDeps
): Promise<HealthInput> {
  const [liveScalarRes, liveSeriesRes, baselineScalarRes] = await mapWithConcurrency(
    [
      () => deps.runQuery(env, runsScalarQuery(), period),
      () => deps.runQuery(env, runsSeriesQuery(), period),
      () => deps.runQuery(env, runsScalarQuery(), BASELINE_PERIOD),
    ],
    CH_CONCURRENCY,
    (task) => task()
  );
  const ctx: RunsContext = {
    liveScalar: liveScalarRes.rows[0] ?? {},
    liveSeries: liveSeriesRes.rows,
    baselineScalar: baselineScalarRes.rows[0] ?? {},
  };

  // Window lengths come from the resolved range, not the period, so clipping can't skew rates.
  const windowMinutes = timeRangeMinutes(liveSeriesRes.timeRange) || periodToMinutes(period);
  const baselineMinutes =
    timeRangeMinutes(baselineScalarRes.timeRange) || periodToMinutes(BASELINE_PERIOD);

  // A measured source that failed still falls back for the remaining shape, but its depth is marked
  // unknown so a failure is never presented as a measurement.
  const measured = await QueueMetricsSource.loadFlow(env, period, ctx, deps);
  let flow: FlowData;
  if (measured.status === "ok") {
    flow = measured.data;
  } else {
    const snapshot = await SnapshotFlowSource.loadFlow(env, period, ctx, deps);
    flow = (snapshot as { status: "ok"; data: FlowData }).data;
    if (measured.status === "failed") {
      flow = { ...flow, pending: { ...flow.pending, availability: "unknown" } };
    }
  }

  const failuresSeries = resampleSeries(
    ctx.liveSeries.map((r) => failureRate(num(r.failures), num(r.completed)))
  );

  const triggered = num(ctx.liveScalar.triggered);
  const completed = num(ctx.liveScalar.completed);
  // Older rows have no `finished`, so fall back to completions rather than a fabricated 0 drain.
  const finished = num(ctx.liveScalar.finished, completed);
  const perMin = (total: number) => (windowMinutes === 0 ? 0 : total / windowMinutes);
  const finishedPerMin = perMin(finished);
  const completedPerMin = perMin(completed);
  const triggeredPerMin = perMin(triggered);
  const normalTriggeredPerMin =
    baselineMinutes === 0 ? 0 : num(ctx.baselineScalar.triggered) / baselineMinutes;

  const rate = failureRate(num(ctx.liveScalar.failures), num(ctx.liveScalar.completed));
  const normalRate = failureRate(
    num(ctx.baselineScalar.failures),
    num(ctx.baselineScalar.completed)
  );

  // A zero baseline can't form a ratio, so it counts as degraded once past the floor.
  const failureDegraded =
    rate >= HEALTH_THRESHOLDS.failures.floorRate &&
    (normalRate === 0 || rate / normalRate >= HEALTH_THRESHOLDS.failures.warnMult);
  const failureBreakdown = failureDegraded
    ? await loadFailureBreakdown(deps, env, period, num(ctx.liveScalar.failures))
    : undefined;

  // Liveness measures telemetry freshness, not recent completions.
  const telemetryAgeMs =
    flow.telemetryLastTs === null ? null : Math.max(0, now.getTime() - flow.telemetryLastTs);

  return {
    scope: env.slug ?? "environment",
    period: humanPeriod(period),
    baselineLabel: `vs your ${BASELINE_PERIOD} normal`,
    generatedAt: now.toISOString(),
    windowMinutes,
    flowSource: flow.flowSource,
    pending: flow.pending,
    startLatency: flow.startLatency,
    throughput: { finishedPerMin, completedPerMin, triggeredPerMin, normalTriggeredPerMin },
    failures: { rate, normalRate, series: failuresSeries },
    duration: {
      p95Ms: num(ctx.liveScalar.dur_p95),
      normalP95Ms: num(ctx.baselineScalar.dur_p95),
    },
    liveness: { telemetryAgeMs },
    flowEvidence: flow.evidence,
    failureBreakdown,
  };
}

async function loadFailureBreakdown(
  deps: HealthDeps,
  env: AuthenticatedEnvironment,
  period: string,
  totalFails: number
): Promise<HealthInput["failureBreakdown"]> {
  if (totalFails <= 0) return undefined;
  const { rows } = await tryQuery(deps, env, failureBreakdownQuery(), period);
  if (rows.length === 0) return undefined;
  const top = rows[0];
  return { task: String(top.task ?? "unknown"), share: num(top.fails) / totalFails };
}

function parseTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  // ClickHouse returns a "1970-01-01 00:00:00" sentinel for max() over no rows.
  const ts = Date.parse(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z"));
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts;
}

/** The most recent of several timestamp cells (epoch ms), or null when none parse. */
function freshestTs(...values: unknown[]): number | null {
  const times = values.map(parseTimestamp).filter((t): t is number => t !== null);
  return times.length === 0 ? null : Math.max(...times);
}

/** Minutes spanned by a resolved query time range (0 if degenerate, so callers can fall back). */
function timeRangeMinutes(range: { from: Date; to: Date }): number {
  const ms = range.to.getTime() - range.from.getTime();
  return ms > 0 ? Math.round(ms / 60_000) : 0;
}

function periodToMinutes(period: string): number {
  const match = /^(\d+)\s*([smhdw])$/.exec(period.trim());
  if (!match) return 60;
  const value = Number(match[1]);
  const unit = match[2];
  const minutes: Record<string, number> = { s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080 };
  return value * (minutes[unit] ?? 60);
}

function humanPeriod(period: string): string {
  return `last ${period}`;
}
