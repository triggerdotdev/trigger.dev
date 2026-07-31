/**
 * "Why is this run waiting?" — a DETERMINISTIC diagnosis. No LLM anywhere in this file.
 *
 * Always computes: how long the run has been waiting (with an honest label), the queue's
 * current depth, the recent scheduling delay, the observed dequeue rate, and the LIMITING
 * CAUSE. Adds a queue-DRAIN eta only when the observed rate is trustworthy.
 *
 * It NEVER computes a per-run start eta. There is no deterministic per-run position source:
 * queue order is offset by priority, sharded by concurrency key, and selected fair-randomly
 * across queues (see internal-packages/dashboard-agent/VERDICTS.md §2). `perRunStartEta`
 * ships as an explicit `{ supported: false }` so a consumer can't read absence as "unknown".
 *
 * The cause tree mirrors the health report's FLOW analyzer
 * (apps/webapp/app/presenters/v3/reports/health/flow.ts) — same thresholds
 * (`HEALTH_THRESHOLDS.flowCause`), same discriminator priority, same rule that a concurrency
 * cause needs real running-capacity evidence before it may be selected.
 *
 * IO lives behind `WaitingRunDeps`, so tests inject plain fake readers (no mocks).
 */

import { formatDurationMilliseconds } from "@trigger.dev/core/v3/utils/durations";
import { HEALTH_THRESHOLDS, isPendingIncreasing } from "../reports/health/health-core";

// ---------------------------------------------------------------------------
// Inputs (what the readers hand back — plain data, no Prisma/ClickHouse types).
// ---------------------------------------------------------------------------

/** The single run row point-read (the ONLY Postgres read on this path). */
export type WaitingRunRow = {
  /** Public run id (friendlyId). */
  friendlyId: string;
  status: string;
  queue: string;
  concurrencyKey: string | null;
  createdAt: Date;
  /** Stamped when the run entered the queue. NULL while a run is delayed. */
  queuedAt: Date | null;
  /** Set once the run is dequeued — the end bound of a completed queue wait. */
  startedAt: Date | null;
  delayUntil: Date | null;
};

/**
 * Queue signals over a recent window. ClickHouse-first: depth series, throttling, wait
 * percentiles and the dequeue count all come from `queue_metrics_v1`. The live "now" numbers
 * (`liveDepth`, `*Running`) come from the run-queue's Redis counters, exactly like the queue
 * pages do — never from a Postgres aggregate.
 */
export type WaitingRunQueueSignals = {
  queueName: string;
  /** Length of the window the metrics cover, in minutes. */
  windowMinutes: number;
  /** Buckets that actually returned data — the ETA's sample size. */
  sampleBuckets: number;
  /** Per-bucket queue depth (oldest first, carry-forward filled). */
  depthSeries: number[];
  /** Per-bucket throttled emissions (running >= limit while queued > 0). NOT filled. */
  throttledSeries: number[];
  /** Runs dequeued across the window (`started_delta`), or null when unmeasured. */
  startedCount: number | null;
  waitP50Ms: number | null;
  waitP95Ms: number | null;
  /** Live queue depth from the run-queue, when available. Preferred over the last bucket. */
  liveDepth: number | null;
  /** Live environment-wide running count, when available. */
  envRunning: number | null;
  /** The environment's concurrency limit (already on the authenticated environment). */
  envLimit: number | null;
  /** Live running count for this queue, when available. */
  queueRunning: number | null;
};

export type WaitingRunDeps = {
  readRun: () => Promise<WaitingRunRow | null>;
  readQueueSignals: (queueName: string) => Promise<WaitingRunQueueSignals | null>;
};

export type WaitingRunInput = {
  /** Evaluation clock — injected so durations and "is the delay in the future" are testable. */
  now: Date;
};

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------

export type WaitingRunCause =
  | "throttled"
  | "env_limit_pinned"
  | "queue_limit_pinned"
  | "stall"
  | "draining_normally"
  | "unknown";

/** Which timestamp the waiting label is measured from — the label's honesty guarantee. */
export type WaitingBasis = "queued_at" | "delay_until" | "created_at";

export type DrainEtaUnavailableReason =
  | "no_signals"
  | "no_backlog"
  | "no_observed_rate"
  | "insufficient_sample"
  | "not_draining";

export type WaitingRunDiagnosis = {
  run: {
    id: string;
    status: string;
    queue: string;
    queuedAt: string | null;
    delayUntil: string | null;
    /**
     * Human phrasing that can never overclaim: "queued for X" only when `queuedAt` exists,
     * "scheduled to start at T" for a delayed run, and "time from creation: X" otherwise.
     */
    waitingLabel: string;
    waitingBasis: WaitingBasis;
    /** True while the run has not been dequeued yet. */
    isWaiting: boolean;
    /**
     * False when `queuedAt` can't be read as this run's queue wait — resumed/retried runs keep a
     * stale `queuedAt` (VERDICTS.md §4), so the number is reported but flagged, never trusted.
     */
    queueWaitReliable: boolean;
  };
  queue: {
    name: string;
    /** Current pending count. null when neither the live counter nor metrics are available. */
    depth: number | null;
    depthSource: "live_queue" | "queue_metrics" | "unavailable";
    /** Observed dequeue rate over the window (runs/min). null when unmeasured. */
    observedThroughputPerMin: number | null;
    schedulingDelay: { p50Ms: number | null; p95Ms: number | null };
    throttled: { share: number; buckets: number };
    concurrency: {
      envRunning: number | null;
      envLimit: number | null;
      queueRunning: number | null;
    };
    windowMinutes: number;
    sampleBuckets: number;
  };
  diagnosis: {
    cause: WaitingRunCause;
    evidence: {
      backlogGrowing: boolean;
      throttledShare: number;
      envRunningShare: number | null;
      /** What kept a more specific cause from being selected (null when nothing was missing). */
      missing: "queue_signals" | "env_concurrency" | null;
    };
  };
  drainEta: { minutes: number; basis: "observed_dequeue_rate" } | null;
  /** Suppression reason, so a consumer knows null means "not trustworthy", not "zero". */
  drainEtaUnavailableReason: DrainEtaUnavailableReason | null;
  perRunStartEta: { supported: false; reason: "no-deterministic-position-source" };
};

const PER_RUN_START_ETA = {
  supported: false,
  reason: "no-deterministic-position-source",
} as const;

/**
 * Drain-ETA trust conditions. An ETA is a promise, so it ships only when the rate behind it is
 * real: a positive rate, enough dequeues that it isn't one lucky event, and enough buckets that
 * the window isn't a single blip. A stalled or unknown queue never gets one — its past rate says
 * nothing about a queue that isn't moving.
 */
export const DRAIN_ETA_TRUST = {
  minSampleBuckets: 3,
  minStartedCount: 5,
};

/** Statuses where the run is still waiting to be picked up. */
const WAITING_STATUSES = new Set(["PENDING", "PENDING_VERSION", "DELAYED", "WAITING_FOR_DEPLOY"]);

/**
 * Statuses whose `queuedAt` is a stale leftover from the FIRST enqueue (resume/retry re-enqueues
 * don't restamp it), so a wait computed from it isn't this attempt's queue wait.
 */
const STALE_QUEUED_AT_STATUSES = new Set(["WAITING_TO_RESUME", "RETRYING_AFTER_FAILURE", "PAUSED"]);

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export async function computeWaitingRunDiagnosis(
  deps: WaitingRunDeps,
  input: WaitingRunInput
): Promise<WaitingRunDiagnosis | null> {
  const run = await deps.readRun();
  if (!run) return null;

  const signals = await deps.readQueueSignals(run.queue);

  return buildDiagnosis(run, signals, input.now);
}

/** Pure assembly — the whole verdict is a function of the run row, the signals, and the clock. */
export function buildDiagnosis(
  run: WaitingRunRow,
  signals: WaitingRunQueueSignals | null,
  now: Date
): WaitingRunDiagnosis {
  const queue = summarizeQueue(run.queue, signals);
  const { cause, evidence } = deriveCause(queue, signals);
  const eta = deriveDrainEta(queue, signals, cause);

  return {
    run: describeRun(run, now),
    queue,
    diagnosis: { cause, evidence },
    drainEta: eta.drainEta,
    drainEtaUnavailableReason: eta.reason,
    perRunStartEta: PER_RUN_START_ETA,
  };
}

// ---------------------------------------------------------------------------
// The run's waiting label (VERDICTS.md §4 — never mislabel a delay as queue latency).
// ---------------------------------------------------------------------------

function describeRun(run: WaitingRunRow, now: Date): WaitingRunDiagnosis["run"] {
  const isWaiting = run.startedAt === null && WAITING_STATUSES.has(run.status);
  const queueWaitReliable = run.queuedAt !== null && !STALE_QUEUED_AT_STATUSES.has(run.status);

  let waitingLabel: string;
  let waitingBasis: WaitingBasis;

  if (run.queuedAt && queueWaitReliable) {
    // Canonical queue wait = startedAt - queuedAt; for a run that hasn't started, now - queuedAt.
    const end = run.startedAt ?? now;
    const ms = Math.max(0, end.getTime() - run.queuedAt.getTime());
    waitingLabel = `queued for ${formatMs(ms)}`;
    waitingBasis = "queued_at";
  } else if (run.delayUntil && run.delayUntil.getTime() > now.getTime()) {
    // A delayed run isn't in the queue yet — this is a schedule, NOT queue latency.
    waitingLabel = `scheduled to start at ${run.delayUntil.toISOString()}`;
    waitingBasis = "delay_until";
  } else {
    // No queuedAt to measure from. Report creation age and SAY that's what it is.
    const ms = Math.max(0, (run.startedAt ?? now).getTime() - run.createdAt.getTime());
    waitingLabel = `time from creation: ${formatMs(ms)}`;
    waitingBasis = "created_at";
  }

  return {
    id: run.friendlyId,
    status: run.status,
    queue: run.queue,
    queuedAt: run.queuedAt?.toISOString() ?? null,
    delayUntil: run.delayUntil?.toISOString() ?? null,
    waitingLabel,
    waitingBasis,
    isWaiting,
    queueWaitReliable,
  };
}

function formatMs(ms: number): string {
  return formatDurationMilliseconds(ms, { style: "short", maxDecimalPoints: 0 });
}

// ---------------------------------------------------------------------------
// Queue summary.
// ---------------------------------------------------------------------------

function summarizeQueue(
  queueName: string,
  signals: WaitingRunQueueSignals | null
): WaitingRunDiagnosis["queue"] {
  if (!signals) {
    return {
      name: queueName,
      depth: null,
      depthSource: "unavailable",
      observedThroughputPerMin: null,
      schedulingDelay: { p50Ms: null, p95Ms: null },
      throttled: { share: 0, buckets: 0 },
      concurrency: { envRunning: null, envLimit: null, queueRunning: null },
      windowMinutes: 0,
      sampleBuckets: 0,
    };
  }

  // Prefer the live counter for "now"; fall back to the freshest MEASURED bucket rather than a
  // confident zero (same choice the health report makes for env pending).
  const lastMeasured =
    signals.depthSeries.length > 0 ? signals.depthSeries[signals.depthSeries.length - 1] : null;
  const depth = signals.liveDepth ?? lastMeasured;
  const depthSource =
    signals.liveDepth !== null
      ? ("live_queue" as const)
      : lastMeasured !== null
        ? ("queue_metrics" as const)
        : ("unavailable" as const);

  const observedThroughputPerMin =
    signals.startedCount === null || signals.windowMinutes <= 0
      ? null
      : signals.startedCount / signals.windowMinutes;

  const throttledBuckets = signals.throttledSeries.filter((t) => t > 0).length;

  return {
    name: signals.queueName,
    depth,
    depthSource,
    observedThroughputPerMin,
    schedulingDelay: { p50Ms: signals.waitP50Ms, p95Ms: signals.waitP95Ms },
    throttled: {
      share: signals.sampleBuckets > 0 ? throttledBuckets / signals.sampleBuckets : 0,
      buckets: throttledBuckets,
    },
    concurrency: {
      envRunning: signals.envRunning,
      envLimit: signals.envLimit,
      queueRunning: signals.queueRunning,
    },
    windowMinutes: signals.windowMinutes,
    sampleBuckets: signals.sampleBuckets,
  };
}

// ---------------------------------------------------------------------------
// The cause tree — flow.ts's discriminators and priority, applied to one queue.
// ---------------------------------------------------------------------------

function deriveCause(
  queue: WaitingRunDiagnosis["queue"],
  signals: WaitingRunQueueSignals | null
): { cause: WaitingRunCause; evidence: WaitingRunDiagnosis["diagnosis"]["evidence"] } {
  const t = HEALTH_THRESHOLDS.flowCause;

  if (!signals || queue.sampleBuckets === 0) {
    return {
      cause: "unknown",
      evidence: {
        backlogGrowing: false,
        throttledShare: queue.throttled.share,
        envRunningShare: null,
        missing: "queue_signals",
      },
    };
  }

  const backlogGrowing = isPendingIncreasing(signals.depthSeries);
  const throttledShare = queue.throttled.share;
  // Same guard as flow.ts #1: without a real limit AND a real running reading, a share is a
  // meaningless 0 that would falsely select `stall`.
  const hasConcurrencyEvidence =
    signals.envLimit !== null && signals.envLimit > 0 && signals.envRunning !== null;
  const envRunningShare = hasConcurrencyEvidence
    ? (signals.envRunning as number) / (signals.envLimit as number)
    : null;
  const envPinned = envRunningShare !== null && envRunningShare >= t.pinnedLevel;
  // A queue's own limit is visible through throttling: `throttled_count` counts exactly the
  // emissions where running >= limit while work was queued. Sustained (most of the window)
  // reads as pinned at the queue limit; intermittent reads as throttled.
  const queueLimitPinned = throttledShare >= t.pinnedShare;
  const queueThrottled = throttledShare >= t.throttledShare;
  const backlogged = queue.depth !== null && queue.depth > 0;
  const observedRate = queue.observedThroughputPerMin;

  const evidence = {
    backlogGrowing,
    throttledShare,
    envRunningShare,
    missing: null as WaitingRunDiagnosis["diagnosis"]["evidence"]["missing"],
  };

  // Priority order copied from flow.ts: stall is a last-resort "it's on our side" cause, so a
  // known config bottleneck (queue throttling) must rule it out first.
  if (
    hasConcurrencyEvidence &&
    !queueThrottled &&
    (envRunningShare as number) < t.stallRunningShare &&
    backlogged &&
    observedRate === 0
  ) {
    return { cause: "stall", evidence };
  }
  if (envPinned && backlogged) {
    return { cause: "env_limit_pinned", evidence };
  }
  if (queueLimitPinned && backlogged) {
    return { cause: "queue_limit_pinned", evidence };
  }
  if (queueThrottled && backlogged) {
    return { cause: "throttled", evidence };
  }
  if (!backlogged || (observedRate !== null && observedRate > 0)) {
    return { cause: "draining_normally", evidence };
  }
  // Backlogged with nothing moving, but no capacity evidence to say whether that's a limit or a
  // stall. flow.ts's lesson: don't name a concurrency cause without the evidence for it.
  return { cause: "unknown", evidence: { ...evidence, missing: "env_concurrency" } };
}

// ---------------------------------------------------------------------------
// Queue-drain ETA — a statement about the QUEUE, never about this run.
// ---------------------------------------------------------------------------

function deriveDrainEta(
  queue: WaitingRunDiagnosis["queue"],
  signals: WaitingRunQueueSignals | null,
  cause: WaitingRunCause
): {
  drainEta: WaitingRunDiagnosis["drainEta"];
  reason: DrainEtaUnavailableReason | null;
} {
  if (!signals) return { drainEta: null, reason: "no_signals" };
  if (queue.depth === null || queue.depth === 0) return { drainEta: null, reason: "no_backlog" };
  // A stalled queue's past rate says nothing about a queue that isn't moving.
  if (cause === "stall") return { drainEta: null, reason: "not_draining" };

  const rate = queue.observedThroughputPerMin;
  if (rate === null || rate <= 0) return { drainEta: null, reason: "no_observed_rate" };
  if (
    queue.sampleBuckets < DRAIN_ETA_TRUST.minSampleBuckets ||
    (signals.startedCount ?? 0) < DRAIN_ETA_TRUST.minStartedCount
  ) {
    return { drainEta: null, reason: "insufficient_sample" };
  }
  // A cause we couldn't name means the evidence is incomplete — don't dress it up as an ETA.
  if (cause === "unknown") return { drainEta: null, reason: "not_draining" };

  const minutes = Math.ceil(queue.depth / rate);
  if (!Number.isFinite(minutes)) return { drainEta: null, reason: "no_observed_rate" };

  return {
    drainEta: { minutes: Math.max(1, minutes), basis: "observed_dequeue_rate" },
    reason: null,
  };
}
