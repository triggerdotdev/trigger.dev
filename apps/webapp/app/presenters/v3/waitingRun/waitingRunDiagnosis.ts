// No per-run start eta exists: priority offsets, concurrency-key sharding and the enqueue fast path
// leave no deterministic position. The cause tree mirrors reports/health/flow.ts.

import { formatDurationMilliseconds } from "@trigger.dev/core/v3/utils/durations";
import { HEALTH_THRESHOLDS, isPendingIncreasing } from "../reports/health/health-core";

export type WaitingRunRow = {
  friendlyId: string;
  status: string;
  queue: string;
  concurrencyKey: string | null;
  createdAt: Date;
  /** Stamped when the run entered the queue. Null while a run is delayed. */
  queuedAt: Date | null;
  /** Set once the run is dequeued: the end bound of a completed queue wait. */
  startedAt: Date | null;
  delayUntil: Date | null;
};

/** Series and percentiles come from `queue_metrics_v1`; the live counts from run-queue Redis. */
export type WaitingRunQueueSignals = {
  queueName: string;
  windowMinutes: number;
  /** Buckets that returned data: the ETA's sample size. */
  sampleBuckets: number;
  /** Per-bucket queue depth, oldest first, carry-forward filled. */
  depthSeries: number[];
  /** Per-bucket throttled emissions (running >= limit while queued > 0). Not filled. */
  throttledSeries: number[];
  /** Runs dequeued across the window, or null when unmeasured. */
  startedCount: number | null;
  waitP50Ms: number | null;
  waitP95Ms: number | null;
  /** Live queue depth from the run-queue. Preferred over the last bucket. */
  liveDepth: number | null;
  envRunning: number | null;
  envLimit: number | null;
  queueRunning: number | null;
};

export type WaitingRunDeps = {
  readRun: () => Promise<WaitingRunRow | null>;
  readQueueSignals: (queueName: string) => Promise<WaitingRunQueueSignals | null>;
};

export type WaitingRunInput = {
  now: Date;
};

export type WaitingRunCause =
  | "throttled"
  | "env_limit_pinned"
  | "queue_limit_pinned"
  | "stall"
  | "draining_normally"
  | "unknown";

/** Which timestamp the waiting label is measured from. */
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
    waitingLabel: string;
    waitingBasis: WaitingBasis;
    isWaiting: boolean;
    /** False when `queuedAt` isn't this run's queue wait: resumed and retried runs keep a stale one. */
    queueWaitReliable: boolean;
  };
  queue: {
    name: string;
    depth: number | null;
    depthSource: "live_queue" | "queue_metrics" | "unavailable";
    /** Observed dequeue rate over the window, in runs/min. Null when unmeasured. */
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
      /** What kept a more specific cause from being selected. Null when nothing was missing. */
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

/** Minimum evidence before a drain ETA ships. */
export const DRAIN_ETA_TRUST = {
  minSampleBuckets: 3,
  minStartedCount: 5,
};

/** Statuses where the run is still waiting to be picked up. */
const WAITING_STATUSES = new Set(["PENDING", "PENDING_VERSION", "DELAYED", "WAITING_FOR_DEPLOY"]);

/** Statuses whose `queuedAt` is a leftover from the first enqueue: re-enqueues don't restamp it. */
const STALE_QUEUED_AT_STATUSES = new Set(["WAITING_TO_RESUME", "RETRYING_AFTER_FAILURE", "PAUSED"]);

export async function computeWaitingRunDiagnosis(
  deps: WaitingRunDeps,
  input: WaitingRunInput
): Promise<WaitingRunDiagnosis | null> {
  const run = await deps.readRun();
  if (!run) return null;

  const signals = await deps.readQueueSignals(run.queue);

  return buildDiagnosis(run, signals, input.now);
}

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

function describeRun(run: WaitingRunRow, now: Date): WaitingRunDiagnosis["run"] {
  const isWaiting = run.startedAt === null && WAITING_STATUSES.has(run.status);
  const queueWaitReliable = run.queuedAt !== null && !STALE_QUEUED_AT_STATUSES.has(run.status);

  let waitingLabel: string;
  let waitingBasis: WaitingBasis;

  if (run.queuedAt && queueWaitReliable) {
    // Queue wait is startedAt - queuedAt, or now - queuedAt when the run hasn't started.
    const end = run.startedAt ?? now;
    const ms = Math.max(0, end.getTime() - run.queuedAt.getTime());
    waitingLabel = `queued for ${formatMs(ms)}`;
    waitingBasis = "queued_at";
  } else if (run.delayUntil && run.delayUntil.getTime() > now.getTime()) {
    // A delayed run isn't in the queue yet: this is a schedule, not queue latency.
    waitingLabel = `scheduled to start at ${run.delayUntil.toISOString()}`;
    waitingBasis = "delay_until";
  } else if (run.delayUntil && run.queuedAt === null) {
    // The delay elapsed but the run isn't enqueued; creation age would hide that.
    const ms = Math.max(0, now.getTime() - run.delayUntil.getTime());
    waitingLabel = `delay elapsed ${formatMs(ms)} ago, not yet enqueued`;
    waitingBasis = "delay_until";
  } else {
    // No queuedAt to measure from, so report creation age.
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

  // Prefer the live counter, then the freshest measured bucket.
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

// flow.ts's discriminators and priority, applied to one queue.
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
  // Without both a real limit and a real running reading the share is a 0 that selects `stall`.
  const hasConcurrencyEvidence =
    signals.envLimit !== null && signals.envLimit > 0 && signals.envRunning !== null;
  const envRunningShare = hasConcurrencyEvidence
    ? (signals.envRunning as number) / (signals.envLimit as number)
    : null;
  const envPinned = envRunningShare !== null && envRunningShare >= t.pinnedLevel;
  // A queue's own limit shows up as throttling: sustained reads as pinned, intermittent as throttled.
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

  // Priority from flow.ts: stall is last resort, so queue throttling must rule it out first.
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
  // Backlogged with nothing conclusive: with concurrency evidence in hand, nothing is missing.
  return {
    cause: "unknown",
    evidence: { ...evidence, missing: hasConcurrencyEvidence ? null : "env_concurrency" },
  };
}

// The drain ETA is about the queue, never about this run.
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
  // A stalled queue's past rate says nothing about when it will drain.
  if (cause === "stall") return { drainEta: null, reason: "not_draining" };

  const rate = queue.observedThroughputPerMin;
  if (rate === null || rate <= 0) return { drainEta: null, reason: "no_observed_rate" };
  if (
    queue.sampleBuckets < DRAIN_ETA_TRUST.minSampleBuckets ||
    (signals.startedCount ?? 0) < DRAIN_ETA_TRUST.minStartedCount
  ) {
    return { drainEta: null, reason: "insufficient_sample" };
  }
  // An unnamed cause means incomplete evidence, so no ETA.
  if (cause === "unknown") return { drainEta: null, reason: "not_draining" };

  const minutes = Math.ceil(queue.depth / rate);
  if (!Number.isFinite(minutes)) return { drainEta: null, reason: "no_observed_rate" };

  return {
    drainEta: { minutes: Math.max(1, minutes), basis: "observed_dequeue_rate" },
    reason: null,
  };
}
