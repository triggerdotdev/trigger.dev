/**
 * Health report FOUNDATION shared by the three analyzers (flow / execution / liveness):
 * the input shape, tunable thresholds, small helpers, and `buildMetrics` (numbers +
 * per-metric severity). No verdict logic here — that lives in the per-analyzer modules.
 */

import { classifySeverity, delta, type Metric, type Severity } from "../report-view-model";

export type HealthInput = {
  scope: string;
  period: string;
  baselineLabel: string;
  generatedAt: string;
  /** live window length in minutes — for anomaly-window / annotation math. */
  windowMinutes: number;
  /** provenance; drives caveat text, not logic. */
  flowSource: "snapshot+runs" | "queue_metrics_v1";
  /**
   * now = live env-level depth; normal = 7d baseline (omitted on the snapshot path, which has
   * no real 7d pending baseline — so we never mislabel a live-window average as "7d normal");
   * series measured (v2) or estimated (v1).
   */
  pending: { now: number; normal?: number; series: number[]; estimated: boolean };
  startLatency: { p95Ms: number; normalP95Ms: number; series: number[] };
  throughput: { donePerMin: number; triggeredPerMin: number; normalTriggeredPerMin: number };
  failures: { rate: number; normalRate: number; series: number[] };
  duration: { p95Ms: number; normalP95Ms: number };
  /** Age of the freshest telemetry (ms). null = no signal to assess -> freshness unknown. */
  liveness: { telemetryAgeMs: number | null };
  /**
   * Flow's cause-tree discriminators (no own severity) — from env_metrics rows + one
   * queue_metrics GROUP BY. Empty-ish when unavailable (cause tree falls back to v1).
   */
  flowEvidence: {
    runningSeries: number[];
    envLimit: number;
    throttledShare: number;
    worstQueue: { name: string; share: number } | null;
    /** runs dead-lettered in the window: 0 = measured none, null = unmeasured (snapshot). */
    dlqDelta: number | null;
  };
  /** Lazy — loaded only when execution degrades (attribution line). */
  failureBreakdown?: { task: string; share: number; region?: string };
};

/** Tunable defaults — first-guess; tune against prod once wired. */
export const HEALTH_THRESHOLDS = {
  // `floor` = absolute warn/crit used when there's no usable baseline (normal 0/undefined),
  // so a spike from a zero baseline (e.g. a never-failing env) isn't classified healthy.
  startLatency: { warnMult: 3, critMult: 10, floor: { warn: 30_000, crit: 120_000 } },
  pending: { warnMult: 2, critMult: 10, floor: { warn: 500, crit: 5_000 } },
  failures: {
    warnMult: 2,
    critMult: 4,
    floorRate: 0.005,
    floor: { warn: 0.02, crit: 0.05 },
  },
  duration: { warnMult: 1.5, critMult: 3, floor: { warn: 60_000, crit: 600_000 } },
  liveness: { freshMs: 60_000, staleMs: 300_000 },
  flowPolicy: { drainCritMinutes: 60 },
  flowCause: {
    stallRunningShare: 0.3, // dequeue_stall: running/limit below this while pending grows
    pinnedLevel: 0.95, // a bucket counts as "pinned" when running >= 95% of limit
    pinnedShare: 0.5, // env_limit_saturation: >= half the window's buckets pinned
    throttledShare: 0.25, // queue_limit_throttling: >= a quarter of the window throttled
    spikeMult: 3, // trigger_spike: triggered/min >= 3x the 7d-normal rate
    // trigger_surge: with NO usable baseline (normal 0), a multiplier is meaningless, so an
    // absolute floor picks the "new volume" cause instead of dropping to the v1 fallback.
    surgePerMin: 100,
  },
  attribution: { minShare: 0.5 }, // name a queue/task/region only when it owns >= half the problem
};

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

export const mean = (xs: number[]) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Deterministic "trending up": mean of the last third vs the first third (direction only). */
export function isPendingIncreasing(series: number[]): boolean {
  if (series.length < 2) return false;
  const third = Math.max(1, Math.floor(series.length / 3));
  return mean(series.slice(-third)) > mean(series.slice(0, third));
}

function multiplierSeverity(
  value: number,
  normal: number | undefined,
  warnMult: number,
  critMult: number,
  floor?: { warn: number; crit: number }
): Severity {
  if (normal === undefined || !Number.isFinite(normal) || normal === 0) {
    // No usable baseline: fall back to an absolute floor so a spike isn't a false green.
    return floor ? classifySeverity(value, floor) : "ok";
  }
  return classifySeverity(value / normal, { warn: warnMult, crit: critMult });
}

/** Look up a metric by id; throws if absent (buildMetrics guarantees the standard set exists). */
export function metricById(metrics: Metric[], id: string): Metric {
  const m = metrics.find((x) => x.id === id);
  if (!m) throw new Error(`health: missing metric ${id}`);
  return m;
}

// ---------------------------------------------------------------------------
// buildMetrics: numbers + per-metric severity. The standard six carry severity; the
// flow-evidence metrics (concurrency, throttled, triggered) are evidence only (severity ok)
// and exist so a cause's metricIds resolve.
// ---------------------------------------------------------------------------

export function buildMetrics(input: HealthInput): Metric[] {
  const t = HEALTH_THRESHOLDS;
  const ev = input.flowEvidence;

  const startLatency: Metric = {
    id: "start_latency_p95",
    value: input.startLatency.p95Ms,
    unit: "ms",
    aggregation: "p95",
    normal: input.startLatency.normalP95Ms,
    delta: delta(input.startLatency.p95Ms, input.startLatency.normalP95Ms),
    series: { points: input.startLatency.series, kind: "measured" },
    severity: multiplierSeverity(
      input.startLatency.p95Ms,
      input.startLatency.normalP95Ms,
      t.startLatency.warnMult,
      t.startLatency.critMult,
      t.startLatency.floor
    ),
  };

  const pending: Metric = {
    id: "pending",
    value: input.pending.now,
    unit: "count",
    normal: input.pending.normal,
    delta: delta(input.pending.now, input.pending.normal),
    series: {
      points: input.pending.series,
      kind: input.pending.estimated ? "estimated" : "measured",
    },
    severity: multiplierSeverity(
      input.pending.now,
      input.pending.normal,
      t.pending.warnMult,
      t.pending.critMult,
      t.pending.floor
    ),
  };

  const net = input.throughput.donePerMin - input.throughput.triggeredPerMin;
  const throughput: Metric = {
    id: "throughput",
    value: net,
    unit: "perMin",
    aggregation: "rate",
    breakdown: { done: input.throughput.donePerMin, triggered: input.throughput.triggeredPerMin },
    severity: net < 0 && isPendingIncreasing(input.pending.series) ? "warn" : "ok",
  };

  const failureSeverity: Severity =
    input.failures.rate < t.failures.floorRate
      ? "ok"
      : multiplierSeverity(
          input.failures.rate,
          input.failures.normalRate,
          t.failures.warnMult,
          t.failures.critMult,
          t.failures.floor
        );
  const failures: Metric = {
    id: "failures",
    value: input.failures.rate,
    unit: "ratio",
    aggregation: "ratio",
    normal: input.failures.normalRate,
    delta: delta(input.failures.rate, input.failures.normalRate),
    series: { points: input.failures.series, kind: "measured" },
    severity: failureSeverity,
  };

  const durP95: Metric = {
    id: "dur_p95",
    value: input.duration.p95Ms,
    unit: "ms",
    aggregation: "p95",
    normal: input.duration.normalP95Ms,
    delta: delta(input.duration.p95Ms, input.duration.normalP95Ms),
    severity: multiplierSeverity(
      input.duration.p95Ms,
      input.duration.normalP95Ms,
      t.duration.warnMult,
      t.duration.critMult,
      t.duration.floor
    ),
  };

  const ageMs = input.liveness.telemetryAgeMs;
  const livenessSeverity: Severity =
    ageMs === null // no signal at all (brand-new/quiet env) — genuinely unknown, so NEUTRAL (ok):
      ? "ok" //         a fine-but-idle env must not surface as a yellow verdict, and it never
      : //              trust-guards. "lagging" (below) IS a real warn; "unknown" is not.
        ageMs > t.liveness.staleMs
        ? "crit"
        : ageMs > t.liveness.freshMs
          ? "warn"
          : "ok";
  const liveness: Metric = {
    id: "liveness",
    // No signal -> value 0 is a placeholder, NOT a real "0ms fresh". `availability: "unknown"`
    // says so, so a structured consumer never reads the 0 as freshness (the finding reason
    // also carries "freshness_unknown"). A finite number keeps the JSON VM valid (no Infinity).
    value: ageMs ?? 0,
    availability: ageMs === null ? "unknown" : "measured",
    unit: "ms",
    severity: livenessSeverity,
  };

  // Flow-evidence metrics (severity ok — evidence, not a verdict).
  const concurrency: Metric = {
    id: "concurrency",
    value: ev.runningSeries.length > 0 ? ev.runningSeries[ev.runningSeries.length - 1] : 0,
    unit: "count",
    breakdown: { limit: ev.envLimit },
    series: { points: ev.runningSeries, kind: "measured" },
    severity: "ok",
  };
  const throttled: Metric = {
    id: "throttled",
    value: ev.throttledShare,
    unit: "ratio",
    severity: "ok",
  };
  const triggered: Metric = {
    id: "triggered",
    value: input.throughput.triggeredPerMin,
    unit: "perMin",
    normal: input.throughput.normalTriggeredPerMin,
    delta: delta(input.throughput.triggeredPerMin, input.throughput.normalTriggeredPerMin),
    severity: "ok",
  };

  return [
    startLatency,
    pending,
    throughput,
    failures,
    durP95,
    liveness,
    concurrency,
    throttled,
    triggered,
  ];
}

// ---------------------------------------------------------------------------
// Drain computation — shared by the flow policy (flow.ts) and the footer (health.ts).
// ---------------------------------------------------------------------------

export function computeDrain(input: HealthInput): { drainMinutes: number; isDrainable: boolean } {
  const donePerMin = input.throughput.donePerMin;
  const drainMinutes = donePerMin === 0 ? Number.POSITIVE_INFINITY : input.pending.now / donePerMin;
  return {
    drainMinutes,
    isDrainable: drainMinutes < HEALTH_THRESHOLDS.flowPolicy.drainCritMinutes,
  };
}
