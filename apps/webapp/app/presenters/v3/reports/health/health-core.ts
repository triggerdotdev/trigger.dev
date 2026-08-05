/**
 * Foundation shared by the flow, execution and liveness analyzers: the input shape, thresholds,
 * helpers, and `buildMetrics`. Verdict logic lives in the per-analyzer modules.
 */

import { classifySeverity, delta, type Metric, type Severity } from "../report-view-model";

export type HealthInput = {
  scope: string;
  period: string;
  baselineLabel: string;
  generatedAt: string;
  windowMinutes: number;
  /** Provenance. Drives caveat text, not logic. */
  flowSource: "snapshot+runs" | "queue_metrics_v1";
  /**
   * `now` is the live env-level depth; `normal` is the 7d baseline, omitted on the snapshot path so
   * a live-window average is never mislabelled as a 7d normal.
   *
   * `availability: "unknown"` means the depth could not be measured at all. `now` is then a
   * placeholder rather than a confident 0, and flow is reported unassessable instead of healthy.
   */
  pending: {
    now: number;
    normal?: number;
    series: number[];
    estimated: boolean;
    availability?: "measured" | "unknown";
  };
  startLatency: { p95Ms: number; normalP95Ms: number; series: number[] };
  /**
   * `finishedPerMin` counts all terminal runs, so it's the rate work leaves the queue and what
   * drain math uses. `completedPerMin` counts successes only and would understate the drain rate
   * on any env with failures.
   */
  throughput: {
    finishedPerMin: number;
    completedPerMin: number;
    triggeredPerMin: number;
    normalTriggeredPerMin: number;
  };
  failures: { rate: number; normalRate: number; series: number[] };
  duration: { p95Ms: number; normalP95Ms: number };
  /** Age of the freshest telemetry in ms. Null means no signal to assess. */
  liveness: { telemetryAgeMs: number | null };
  /** Flow's cause-tree discriminators. These carry no severity of their own. */
  flowEvidence: {
    runningSeries: number[];
    /**
     * Epoch ms of each `runningSeries` bucket, aligned by index. Absent when the source can't say,
     * and contiguity then falls back to index adjacency.
     */
    runningBucketsMs?: number[];
    /**
     * Bucket cadence of `runningSeries` and how many buckets the window should contain. The rows
     * are not gap-filled, so this is the only way to tell "pinned for 60 of 60 minutes" from "two
     * fresh samples arrived in a 60-minute window". Absent means the cadence is unknown, and the
     * received buckets are assumed to spread evenly over the window.
     */
    sampling?: { bucketMinutes: number; expectedBuckets: number } | null;
    envLimit: number;
    throttledShare: number;
    worstQueue: { name: string; share: number } | null;
    /** Runs dead-lettered in the window. 0 is a measured none, null is unmeasured. */
    dlqDelta: number | null;
  };
  /** Loaded only when execution degrades. */
  failureBreakdown?: { task: string; share: number; region?: string };
};

export const HEALTH_THRESHOLDS = {
  // `floor` is the absolute warn/crit used when there's no usable baseline, so a spike from a zero
  // baseline isn't classified healthy.
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
    // trigger_surge: with no usable baseline a multiplier is meaningless, so an absolute floor
    // picks the "new volume" cause instead of dropping to the symptom fallback.
    surgePerMin: 100,
    // Minimum share of the window's expected buckets that must have arrived before a
    // concurrency-shaped cause may be named. Below it the series is too gappy to support a cause or
    // a duration, so flow drops to a symptom-level verdict. Buckets come from queue activity rather
    // than a heartbeat, so a sparse window is normal for a quiet env.
    minCoverage: 0.5,
  },
  attribution: { minShare: 0.5 }, // name a queue/task/region only when it owns >= half the problem
};

export const mean = (xs: number[]) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Trending up: mean of the last third against the first third. Direction only. */
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

/** True when the backlog depth could not be measured, so `pending.now` is a placeholder. */
export function isPendingUnknown(input: HealthInput): boolean {
  return input.pending.availability === "unknown";
}

export type BucketCoverage = {
  /** Buckets the window should contain at the source's cadence. */
  expectedBuckets: number;
  receivedBuckets: number;
  bucketMinutes: number;
  /** Received over expected. 1 when the cadence is unknown. */
  coverage: number;
  /** Enough of the window arrived to support a cause and a duration. */
  sufficient: boolean;
  /** True when the source reported its cadence, so gaps are detectable. */
  known: boolean;
};

/**
 * How much of the window actually arrived. Without the source's cadence the received buckets are
 * assumed to span the window evenly; with it, a gappy feed is visible and shares are expressed
 * against expected buckets.
 */
export function bucketCoverage(input: HealthInput): BucketCoverage {
  const received = input.flowEvidence.runningSeries.length;
  const sampling = input.flowEvidence.sampling;
  if (!sampling || sampling.expectedBuckets <= 0) {
    return {
      expectedBuckets: received,
      receivedBuckets: received,
      bucketMinutes: received > 0 ? input.windowMinutes / received : 0,
      coverage: 1,
      sufficient: true,
      known: false,
    };
  }
  const coverage = received / sampling.expectedBuckets;
  return {
    expectedBuckets: sampling.expectedBuckets,
    receivedBuckets: received,
    bucketMinutes: sampling.bucketMinutes,
    coverage,
    sufficient: coverage >= HEALTH_THRESHOLDS.flowCause.minCoverage,
    known: true,
  };
}

export function metricById(metrics: Metric[], id: string): Metric {
  const m = metrics.find((x) => x.id === id);
  if (!m) throw new Error(`health: missing metric ${id}`);
  return m;
}

// The standard six metrics carry severity. The flow-evidence metrics are evidence only and exist so
// a cause's metricIds resolve.

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

  // An unmeasurable depth must not be classified: a placeholder 0 would read as a confident "no
  // backlog" green. The flow analyzer turns `availability: "unknown"` into an unassessable verdict.
  const pendingUnknown = isPendingUnknown(input);
  const pending: Metric = {
    id: "pending",
    value: input.pending.now,
    unit: "count",
    availability: pendingUnknown ? "unknown" : "measured",
    normal: input.pending.normal,
    delta: pendingUnknown ? undefined : delta(input.pending.now, input.pending.normal),
    series: {
      points: input.pending.series,
      kind: input.pending.estimated ? "estimated" : "measured",
    },
    severity: pendingUnknown
      ? "ok"
      : multiplierSeverity(
          input.pending.now,
          input.pending.normal,
          t.pending.warnMult,
          t.pending.critMult,
          t.pending.floor
        ),
  };

  // Net drain uses all terminal runs, since completions alone would show a permanent deficit on
  // any env with failures.
  const net = input.throughput.finishedPerMin - input.throughput.triggeredPerMin;
  const throughput: Metric = {
    id: "throughput",
    value: net,
    unit: "perMin",
    aggregation: "rate",
    breakdown: {
      done: input.throughput.finishedPerMin,
      triggered: input.throughput.triggeredPerMin,
    },
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
  // No signal at all is genuinely unknown, so it stays neutral: a fine-but-idle env must not
  // surface as a yellow verdict. Lagging telemetry below is a real warn; unknown is not.
  const livenessSeverity: Severity =
    ageMs === null
      ? "ok"
      : ageMs > t.liveness.staleMs
        ? "crit"
        : ageMs > t.liveness.freshMs
          ? "warn"
          : "ok";
  const liveness: Metric = {
    id: "liveness",
    // With no signal, 0 is a placeholder rather than a real "0ms fresh". `availability: "unknown"`
    // says so, and a finite number keeps the JSON view model valid.
    value: ageMs ?? 0,
    availability: ageMs === null ? "unknown" : "measured",
    unit: "ms",
    severity: livenessSeverity,
  };

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

export function computeDrain(input: HealthInput): { drainMinutes: number; isDrainable: boolean } {
  // The drain rate counts runs leaving the queue, not just successful completions.
  const finishedPerMin = input.throughput.finishedPerMin;
  const drainMinutes =
    finishedPerMin === 0 ? Number.POSITIVE_INFINITY : input.pending.now / finishedPerMin;
  return {
    drainMinutes,
    // An unmeasurable depth can't produce an ETA, so never offer "it drains" off a placeholder.
    isDrainable:
      !isPendingUnknown(input) && drainMinutes < HEALTH_THRESHOLDS.flowPolicy.drainCritMinutes,
  };
}
