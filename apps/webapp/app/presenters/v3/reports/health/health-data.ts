/**
 * The `health` report's DATA layer — the ONLY place SQL / Redis IO lives. Loads a
 * `HealthInput` (plain numbers) that the pure `interpret()` turns into a VM.
 *
 * Flow signal is sourced behind `FlowSource`:
 *   - QueueMetricsSource (preferred) — MEASURED queue depth + real scheduling delay
 *     (p95 wait) from `env_metrics`, which is env-level, so there is no per-queue split.
 *   - SnapshotFlowSource (fallback)  — live Redis depth + an ESTIMATED backlog proxy
 *     and `runs.queued_duration`, used until the queue-metrics pipeline has populated
 *     `env_metrics` for this env.
 *
 * `flowSource` records which ran and drives `pending.estimated`, so the "informational
 * only" caveat drops automatically on the measured path. Execution, liveness and
 * throughput always come from `runs`.
 *
 * Failure policy: a source falls back only on a RECOGNIZED rollout error (the table/column isn't
 * there yet). Any other failure — and a Redis miss with no measured depth behind it — sets
 * `pending.availability: "unknown"` so the report says "couldn't measure" rather than "zero".
 */

import { calculateTimeBucketInterval, type TimeBucketInterval } from "@internal/tsql";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { executeQuery, isQueryConcurrencyRejection } from "~/services/queryService.server";
import { envMetricsSchema } from "~/v3/querySchemas";
import { engine } from "~/v3/runEngine.server";
import { HEALTH_THRESHOLDS, type HealthInput } from "./health";

/** §5.B — failures = user-code failures only (Expired/Canceled excluded from both sides). */
const FAILURE_STATUSES = "'Failed','Crashed','System failure','Timed out'";

/** All terminal statuses — a run that reached any of these has left the queue (not backlog). */
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

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Downsample a per-bucket series to ~N points so the sparkline width is stable (plan §5.C). */
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

/**
 * Bug 1 fix — ClickHouse query concurrency cap. The query service rejects the 4th
 * concurrent query per project (-> `runQuery` throws -> 500); this loader used to fire
 * up to 4 at once. `mapWithConcurrency` runs `fn` over `items` with at most `limit` in
 * flight, preserving order. We cap CH calls at 2 to leave headroom under the limit of 3
 * for other project traffic. (Redis calls don't count — kept outside this helper.)
 */
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

/** Max ClickHouse queries this loader keeps in flight (limit of 3, leave headroom). */
const CH_CONCURRENCY = 2;

/**
 * The per-project limit (3) is shared across ALL in-flight requests, not just this
 * loader — so concurrent report requests can still transiently exceed it and get a
 * rejection. It's retryable (a slot frees when another query finishes), so we back off
 * and retry rather than surface a 500. Scheduling only — same query, same result.
 */
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

/** rows + the actual (clip-aware) time window the query service resolved for this run. */
type QueryResult = { rows: Row[]; timeRange: { from: Date; to: Date } };

/** Runs one (TRQL) report query. Injectable so tests can drive the loader with canned results. */
export type HealthQueryRunner = (
  env: AuthenticatedEnvironment,
  query: string,
  period: string
) => Promise<QueryResult>;

/**
 * The loader's IO boundary (§7 Seam A): ClickHouse via the query service, Redis via the
 * engine. Defaults wire the real singletons; overriding lets tests drive the loader's
 * orchestration without booting the env-bound query-service client.
 */
export type HealthDeps = {
  runQuery: HealthQueryRunner;
  lengthOfEnvQueue: (env: AuthenticatedEnvironment) => Promise<number | undefined>;
};

/**
 * The 7d baseline changes slowly, so cache it briefly (per env + query) to avoid recomputing a
 * wide query on every request — the biggest lever on query pressure (#12). Only the default
 * runner caches; injected test runners bypass this entirely, so test isolation is preserved.
 */
const BASELINE_CACHE_TTL_MS = 5 * 60_000;
const baselineCache = new Map<string, { expiresAt: number; result: QueryResult }>();

/**
 * Store a baseline result, first sweeping expired entries so envs that stop requesting reports
 * don't linger in memory forever. Writes only happen on a cache miss (~once per env per TTL), so
 * a full sweep here is cheap and keeps the map bounded to recently-active environments.
 */
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
    // Retry transient concurrency rejections; rethrow anything else (e.g. a bad query) so
    // callers/tryQuery can handle it. Exponential "full jitter" backoff — delay picked uniformly
    // from [0, min(cap, base·2^attempt)) — so concurrent report requests don't wake in lockstep
    // and re-collide on the same 3 query slots.
    if (attempt < CH_REJECTION_RETRIES && isConcurrencyRejection(result.error)) {
      const window = Math.min(CH_REJECTION_BACKOFF_CAP_MS, CH_REJECTION_BACKOFF_MS * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * window)));
      continue;
    }
    throw result.error;
  }
}

// ---------------------------------------------------------------------------
// runs queries (execution + liveness + throughput; also feed the snapshot fallback).
// executeQuery injects tenant isolation + the time window, so we never write WHERE.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// env_metrics queries (measured queue depth + scheduling delay).
// ---------------------------------------------------------------------------

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
 * Worst queue by CURRENT pending depth. `argMax(max_queued, bucket_start)` = each queue's depth in
 * its latest bucket, so it's a real point-in-time depth — not a peak from some other moment. The
 * share's denominator comes from `queueTotalsQuery` (all queues), NOT from these rows: they stop at
 * 20. Best-effort.
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
 * Env-wide queue totals over ALL queues — the denominators the per-queue numbers are shares of.
 *
 *  - `dlq_total`: runs dead-lettered across the window. `dlq_delta` is per-queue cumulative-counter
 *    state, so it must be merged per queue then summed (never merged across queues).
 *  - `total_queued`: point-in-time backlog across every queue, i.e. the denominator for the worst
 *    queue's share. It MUST be computed here rather than by summing `queueWorstQuery`'s rows: that
 *    query is LIMIT-ed to the top 20, so summing it would divide by a fraction of the backlog and
 *    inflate every share (40 of 200 would read as 50%).
 *
 * Best-effort — absent columns just yield no rows.
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

/** Top failing task (lazy — only when execution degrades). Best-effort. */
function failureBreakdownQuery(): string {
  return `SELECT
  task_identifier AS task,
  countIf(status IN (${FAILURE_STATUSES})) AS fails
FROM runs
GROUP BY task
ORDER BY fails DESC
LIMIT 10`;
}

/** Default IO wiring — the real query-service runner + the engine's env-queue length. */
const defaultHealthDeps: HealthDeps = {
  runQuery: executeReportQuery,
  lengthOfEnvQueue: (env) => engine.lengthOfEnvQueue(env),
};

/**
 * Run a BEST-EFFORT query — one whose absence only costs an optional detail (dead-letter volume,
 * worst-queue attribution, failing-task breakdown). Never break the report over it; the callers
 * treat "no rows" as "unmeasured" rather than as a measured zero.
 */
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

// ---------------------------------------------------------------------------
// FlowSource seam (§7 Seam A).
// ---------------------------------------------------------------------------

export type FlowData = {
  flowSource: HealthInput["flowSource"];
  pending: HealthInput["pending"];
  startLatency: { p95Ms: number; normalP95Ms: number; series: number[] };
  evidence: HealthInput["flowEvidence"];
  /**
   * Epoch ms of the freshest telemetry the source saw (latest env_metrics bucket and/or latest
   * run) — how the report tells "data current" from "pipeline stale", independent of traffic.
   * null when no signal exists at all (brand-new/empty env) -> liveness "unknown", not stale.
   */
  telemetryLastTs: number | null;
};

const EMPTY_EVIDENCE: HealthInput["flowEvidence"] = {
  runningSeries: [],
  envLimit: 0,
  throttledShare: 0,
  worstQueue: null,
  dlqDelta: null, // snapshot path: dead-letter volume is unmeasured
};

/** The runs results loadHealthInput already fetched, so the snapshot fallback needn't re-query. */
type RunsContext = { liveScalar: Row; liveSeries: Row[]; baselineScalar: Row };

/**
 * Why a source produced no data — the distinction that keeps a failure from masquerading as a
 * measurement:
 *   - "unavailable": a RECOGNIZED rollout state (table/column not there yet, or no rows). The next
 *     source down is a legitimate substitute.
 *   - "failed":      anything else (CH outage, bad SQL, schema change, a bug here). We do not know
 *     what we don't know, so the flow verdict must come out unassessable rather than quietly
 *     downgraded to a proxy that could read "backlog 0".
 */
export type FlowLoadResult =
  | { status: "ok"; data: FlowData }
  | { status: "unavailable" }
  | { status: "failed"; error: unknown };

export interface FlowSource {
  loadFlow(
    env: AuthenticatedEnvironment,
    period: string,
    ctx: RunsContext,
    deps: HealthDeps
  ): Promise<FlowLoadResult>;
}

/**
 * ClickHouse errors that mean "this table/column isn't rolled out here yet" — the ONLY failures the
 * measured source may treat as a benign fallback. Matched on the wrapped error text because the
 * client collapses the CH error into a message (`Unable to query clickhouse: …`), so the numeric
 * code / symbolic name is all that survives.
 *   60 UNKNOWN_TABLE · 47 UNKNOWN_IDENTIFIER · 81 UNKNOWN_DATABASE
 */
const ROLLOUT_ERROR_PATTERNS = [
  /\bUNKNOWN_(?:TABLE|IDENTIFIER|DATABASE)\b/,
  /\bCode:\s*(?:60|47|81)\b/,
  /\bTable\b[^.]*\bdoes\s?n?o?t?'?t?\s*exist/i,
  /\bUnknown (?:table|identifier|column|database)\b/i,
];

function isRolloutError(error: unknown): boolean {
  // Prefer a structured code/type if one ever survives the wrapping.
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const code = String(record.code ?? "");
    const type = String(record.type ?? "");
    if (code === "60" || code === "47" || code === "81") return true;
    if (/^UNKNOWN_(TABLE|IDENTIFIER|DATABASE)$/.test(type)) return true;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  return ROLLOUT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Preferred source: measured queue depth + scheduling-delay p95 from `env_metrics`.
 * Returns null when the pipeline hasn't populated the table yet, so the caller can fall
 * back to the snapshot.
 */
export const QueueMetricsSource: FlowSource = {
  async loadFlow(env, period, ctx, deps) {
    try {
      // Redis depth isn't a CH query, so it runs alongside (doesn't count toward the cap).
      // Guard the rejection: if the CH queries throw first we jump to catch without awaiting
      // this, and an unhandled Redis rejection would crash the process.
      const pendingNowPromise = deps.lengthOfEnvQueue(env).catch(() => undefined);

      // Bug 1 fix — route all CH queries through the concurrency cap (max 2 in flight).
      // Every task returns the same `{ rows, timeRange? }` shape so mapWithConcurrency infers a
      // single element type — a mixed union trips its generic inference.
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

      // Telemetry freshness = the freshest of the latest env_metrics bucket (a heartbeat
      // independent of traffic) and the latest run recorded.
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
      // A RECOGNIZED rollout error (env_metrics not there yet) is a benign fallback. Anything else
      // is a real failure: reporting it as "unavailable" would silently hand the verdict to the
      // proxy path, where a Redis miss used to become "backlog 0" — i.e. a measurement failure
      // rendered as good news. Surface it so the flow verdict comes out unassessable.
      if (isRolloutError(error)) return { status: "unavailable" };
      logger.error("report health: measured flow source failed", {
        environmentId: env.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: "failed", error };
    }
  },
};

/** Minutes per env_metrics bucket for a resolved range — the same interval the printer emits. */
const INTERVAL_UNIT_MINUTES: Record<TimeBucketInterval["unit"], number> = {
  SECOND: 1 / 60,
  MINUTE: 1,
  HOUR: 60,
  DAY: 1440,
  WEEK: 10_080,
  MONTH: 43_200,
};

/**
 * Cadence + expected bucket count for the env_metrics series. Derived from the SAME thresholds the
 * query printer uses, so "expected" matches the buckets the query would emit — the reference a
 * gappy series is measured against (rows are not gap-filled / WITH FILL-ed).
 */
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
  // Dead-letter volume (0 = measured none; no rows -> unmeasured -> null).
  const dlqDelta = totals !== undefined ? Math.round(num(totals.dlq_total)) : null;

  // Throttled share = fraction of the window's buckets with any queue-level throttling. Measured
  // against EXPECTED buckets when the cadence is known — over received rows alone, two throttled
  // samples in an hour would read as "throttled the whole hour".
  const throttledBuckets = series.filter((r) => num(r.throttled) > 0).length;
  const throttledDenominator = sampling?.expectedBuckets ?? series.length;
  const throttledShare = throttledDenominator > 0 ? throttledBuckets / throttledDenominator : 0;

  // Worst queue = top queue's share of current pending. The denominator is the env-wide total from
  // `queueTotalsQuery` (all queues), never the sum of these top-20 rows — that would divide by a
  // fraction of the backlog and inflate the share past the attribution threshold. No total means
  // no denominator, so no attribution.
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

  // Prefer live Redis depth; if it's unavailable fall back to the latest MEASURED queued from
  // env_metrics (still a real number) rather than a misleading confident zero (#7).
  const lastMeasuredQueued = num(series[series.length - 1]?.queued);

  // Bucket timestamps, so a gappy running series can't read as a continuous one. Only carried when
  // EVERY bucket parsed — a partial set would make "adjacent" meaningless.
  const bucketTimestamps = series.map((r) => parseTimestamp(r.t));
  const runningBucketsMs = bucketTimestamps.every((t): t is number => t !== null)
    ? bucketTimestamps
    : undefined;

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
      p95Ms: num(liveScalar.wait_p95),
      normalP95Ms: num(baselineScalar.wait_p95),
      series: resampleSeries(series.map((r) => num(r.wait_p95))),
    },
    evidence: {
      // native resolution — cause discriminators read shares off this series.
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
 * Fallback: live Redis depth (accurate "now") + an estimated backlog proxy from `runs`
 * (cumulative triggered - finished) and `runs.queued_duration` for latency. The proxy is a
 * shape-only TREND (`estimated: true`): it starts at 0 within the window and can't see
 * backlog that predates it.
 */
export const SnapshotFlowSource: FlowSource = {
  async loadFlow(env, _period, ctx, deps) {
    // Guard Redis: this is the last-resort source, so a failure must not break the report.
    const pendingNow = await deps.lengthOfEnvQueue(env).catch(() => undefined);

    // Subtract ALL terminal runs, not just Completed — else failed/expired/canceled runs
    // linger in the proxy as phantom backlog forever.
    let backlog = 0;
    const proxy = ctx.liveSeries.map((r) => {
      backlog = Math.max(0, backlog + num(r.triggered) - num(r.finished));
      return backlog;
    });
    const series = resampleSeries(proxy);

    // Redis is the ONLY depth measurement on this path. When it fails we must not substitute 0 —
    // "we couldn't measure the backlog" would become "the backlog is zero", i.e. a green verdict
    // manufactured out of an outage. Fall back to the last proxy point (a shape-only estimate) and
    // mark the depth unknown, which makes flow unassessable instead of healthy.
    const depthUnavailable = pendingNow === undefined;
    const lastProxyPoint = proxy.length > 0 ? proxy[proxy.length - 1] : 0;

    return {
      status: "ok",
      data: {
        flowSource: "snapshot+runs",
        pending: {
          now: pendingNow ?? lastProxyPoint,
          // No 7d pending baseline on this path — omit `normal` rather than pass off a
          // live-window proxy average as "7d normal" (#8). Severity falls back to an absolute floor.
          normal: undefined,
          series,
          estimated: true,
          availability: depthUnavailable ? "unknown" : "measured",
        },
        startLatency: {
          p95Ms: num(ctx.liveScalar.start_latency_p95),
          normalP95Ms: num(ctx.baselineScalar.start_latency_p95),
          series: resampleSeries(ctx.liveSeries.map((r) => num(r.start_latency_p95))),
        },
        // No cause-tree evidence; interpret falls back to v1 symptoms.
        evidence: EMPTY_EVIDENCE,
        // Telemetry freshness is genuinely UNKNOWN here: this path has no pipeline heartbeat, and
        // run activity is not one — a quiet env whose last run was 10 minutes ago has a perfectly
        // healthy pipeline, so reporting "stale, check the control plane" off `max(triggered_at)`
        // would confuse "no work" with "no telemetry". null -> liveness unknown (neutral).
        telemetryLastTs: null,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// loadHealthInput.
// ---------------------------------------------------------------------------

export async function loadHealthInput(
  env: AuthenticatedEnvironment,
  period: string,
  now: Date = new Date(),
  deps: HealthDeps = defaultHealthDeps
): Promise<HealthInput> {
  // Bug 1 fix — route the runs-phase CH queries through the concurrency cap (max 2)
  // instead of firing all 3 at once, so we never exceed the per-project limit.
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

  // Window lengths come from the query service's resolved (clip-aware) range, not a
  // re-parse of the period — so `maxQueryPeriod` clipping can't skew per-minute rates
  // or annotation math. periodToMinutes is a fallback for a degenerate range.
  const windowMinutes = timeRangeMinutes(liveSeriesRes.timeRange) || periodToMinutes(period);
  const baselineMinutes =
    timeRangeMinutes(baselineScalarRes.timeRange) || periodToMinutes(BASELINE_PERIOD);

  // Prefer measured queue metrics; fall back to the runs snapshot when the pipeline hasn't reached
  // this env yet. A measured source that FAILED (not merely absent) still falls back for the
  // remaining shape, but the depth is marked unknown — a failure must never be presented as a
  // measurement, and the report is flagged untrustworthy for machine consumers.
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
  // Every TERMINAL run leaves the queue, so `finished` — not `completed` — is the drain rate.
  // Older rows (or a query without the column) yield 0; fall back to completions then, which is
  // the previous behaviour rather than a fabricated 0 drain.
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

  // Lazy failure attribution — only when execution is actually degraded.
  // A fresh failure pattern from a clean 0% baseline is exactly when attribution matters most,
  // so a zero baseline (can't form a ratio) counts as degraded once past the floor.
  const failureDegraded =
    rate >= HEALTH_THRESHOLDS.failures.floorRate &&
    (normalRate === 0 || rate / normalRate >= HEALTH_THRESHOLDS.failures.warnMult);
  const failureBreakdown = failureDegraded
    ? await loadFailureBreakdown(deps, env, period, num(ctx.liveScalar.failures))
    : undefined;

  // Liveness = telemetry freshness (how recent is the newest data), NOT "recent completions":
  // a quiet env with a fresh pipeline is fresh; a dead pipeline is stale. null -> unknown.
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

// ---------------------------------------------------------------------------
// Small local helpers.
// ---------------------------------------------------------------------------

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
