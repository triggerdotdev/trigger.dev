/**
 * Deterministic evaluation of one watch condition, with IO behind `WatchCheckDeps`. `unavailable`
 * is never a verdict, durations carry their basis, and `observed` is kept apart from the result.
 */

import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3/utils/durations";
import {
  watchRunDisposition,
  type WatchCheckResult,
  type WatchObservedOutcome,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";

/** The single run point-read. Postgres is authoritative for run state. */
export type WatchRunRow = {
  friendlyId: string;
  status: string;
  queue: string;
  createdAt: Date;
  /** Stamped when the run entered the queue. NULL while a run is delayed. */
  queuedAt: Date | null;
  /** Set once the run is dequeued. */
  startedAt: Date | null;
  completedAt: Date | null;
  delayUntil: Date | null;
};

export type WatchQueueDepth = {
  /** Pending count for the queue, as of `asOf`. */
  depth: number;
  source: "live_queue" | "queue_metrics";
  /** A stale reading can never answer "drained". */
  current: boolean;
  /** What instant the reading describes, when it isn't the live counter. */
  asOf?: Date;
};

/**
 * The oldest still-waiting run's age in one queue. A non-current age is wrong in both
 * directions, so `checkQueueOldestAge` refuses it rather than comparing it.
 */
export type WatchQueueOldestAge = {
  /** Age of the oldest run still waiting, in ms. Null when nothing is waiting. */
  ageMs: number | null;
  source: "live_queue" | "queue_metrics";
  current: boolean;
  asOf?: Date;
};

/** What we know about the watched error's occurrences relative to `since`. */
export type WatchErrorRecurrence = {
  /** Earliest occurrence proven after `since`. Null with a `lastSeenAt` means not since. */
  occurredAt: Date | null;
  /** How precisely `occurredAt` is known: to the millisecond, or to its minute. */
  occurredAtPrecision: "exact" | "minute" | null;
  /** Occurrences after `since`. A lower bound when `countApproximate`. */
  countSince: number;
  /** True when occurrences in the watch's creation minute can't be separated out. */
  countApproximate: boolean;
  /** The fingerprint's most recent occurrence, whenever it was. */
  lastSeenAt: Date | null;
};

export type WatchHealthSeverity = "ok" | "warn" | "crit";

export type WatchHealthSnapshot = {
  /** `facts.trustworthy` from the health report. Untrustworthy never fires recovery. */
  trustworthy: boolean;
  severity: WatchHealthSeverity;
};

/**
 * The readers a check may use. Each may throw, which the caller turns into `unavailable`.
 * `null` means the source answered and there is nothing there.
 */
export type WatchCheckDeps = {
  /** Run point-read by public run id, scoped to the watch's environment. */
  readRun: (runId: string) => Promise<WatchRunRow | null>;
  /** Does this queue exist in the watch's environment? */
  queueExists: (queue: string) => Promise<boolean>;
  /** Current pending count, live run-queue first with a ClickHouse fallback. */
  readQueueDepth: (queue: string) => Promise<WatchQueueDepth | null>;
  /** Age of the oldest run still waiting in the queue, right now. */
  readQueueOldestAge: (queue: string) => Promise<WatchQueueOldestAge | null>;
  /** `null` means the fingerprint has no occurrences at all in this environment. */
  readErrorRecurrence: (fingerprint: string, since: Date) => Promise<WatchErrorRecurrence | null>;
  /** The health report's current verdict for the watch's environment. */
  readHealth: () => Promise<WatchHealthSnapshot | null>;
};

export type WatchCheckInput = {
  now: Date;
  /** The recurrence window's start: the server-set `spec.since`, never caller-set. */
  since: Date;
  /**
   * The previous check's facts, for the stateful kinds. A check's own facts are the only
   * storage for its state. Absent means no prior observation, never zero.
   */
  previous?: Record<string, unknown> | null;
};

/**
 * The previous check's facts out of `lastResult`, which holds raw facts, the check endpoint's
 * envelope, or the failure wrapper. The wrapper is unwrapped, so a streak survives a gap.
 */
export function previousCheckFacts(lastResult: unknown): Record<string, unknown> | null {
  if (!lastResult || typeof lastResult !== "object" || Array.isArray(lastResult)) return null;
  const record = lastResult as Record<string, unknown>;

  if (record.checkFailed === true) return previousCheckFacts(record.previous);
  if (record.facts && typeof record.facts === "object" && !Array.isArray(record.facts)) {
    return record.facts as Record<string, unknown>;
  }
  return record;
}

export type WatchCheckOutcome = {
  result: WatchCheckResult;
  facts: Record<string, unknown>;
  /** Frozen onto the row by the resolving transition, so no surface re-reads the source. */
  observed: WatchObservedOutcome;
};

// Mirrors ~/v3/taskStatus. Kept local so this module has no server-side import.

const FINAL_STATUSES = new Set([
  "CANCELED",
  "INTERRUPTED",
  "COMPLETED_SUCCESSFULLY",
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "CRASHED",
  "EXPIRED",
  "TIMED_OUT",
]);

/**
 * Statuses whose `queuedAt` is a leftover from the first enqueue, since resume/retry
 * re-enqueues don't restamp it, so a wait computed from it isn't this attempt's.
 */
const STALE_QUEUED_AT_STATUSES = new Set(["WAITING_TO_RESUME", "RETRYING_AFTER_FAILURE", "PAUSED"]);

export function isTerminalRunStatus(status: string): boolean {
  return FINAL_STATUSES.has(status);
}

function formatMs(ms: number): string {
  return formatDurationMilliseconds(ms, { style: "short", maxDecimalPoints: 0 });
}

/** Which timestamp a wait was measured from. */
export type WatchWaitBasis = "queued_at" | "delay_until" | "created_at";

/**
 * The wait a run has accumulated, labelled with what the data supports. A resumed, retried or
 * paused run's stale `queuedAt` is never measured from.
 */
export function describeRunWait(
  run: WatchRunRow,
  now: Date
): {
  waitMs: number | null;
  waitBasis: WatchWaitBasis;
  waitLabel: string;
  /** True only when the wait is this attempt's queue wait. */
  queueWaitReliable: boolean;
} {
  const queueWaitReliable = run.queuedAt !== null && !STALE_QUEUED_AT_STATUSES.has(run.status);
  const end = run.startedAt ?? now;

  if (run.queuedAt && queueWaitReliable) {
    const waitMs = Math.max(0, end.getTime() - run.queuedAt.getTime());
    return {
      waitMs,
      waitBasis: "queued_at",
      waitLabel: `queued for ${formatMs(waitMs)}`,
      queueWaitReliable,
    };
  }

  if (run.delayUntil && run.delayUntil.getTime() > now.getTime()) {
    return {
      waitMs: null,
      waitBasis: "delay_until",
      waitLabel: `scheduled to start at ${run.delayUntil.toISOString()}`,
      queueWaitReliable,
    };
  }

  // No `queuedAt`, or one from an earlier attempt: fall back to the run's age.
  const waitMs = Math.max(0, end.getTime() - run.createdAt.getTime());
  const resumeOrRetry = run.queuedAt !== null;
  return {
    waitMs,
    waitBasis: "created_at",
    waitLabel: resumeOrRetry
      ? `waiting to ${run.status === "RETRYING_AFTER_FAILURE" ? "retry" : "resume"}; time from creation: ${formatMs(waitMs)}`
      : `time from creation: ${formatMs(waitMs)}`,
    queueWaitReliable,
  };
}

/**
 * Satisfied the moment `startedAt` exists, whatever the current status. Terminal with no
 * `startedAt` can never start, so it is `terminal_unsatisfied`.
 */
export async function checkRunStart(
  spec: Extract<WatchSpec, { kind: "run_start" }>,
  deps: WatchCheckDeps,
  input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const run = await deps.readRun(spec.runId);
  if (!run) {
    // Existence was validated at creation, so the run is gone and can never start.
    return {
      result: "terminal_unsatisfied",
      facts: { runId: spec.runId, reason: "run_not_found" },
      observed: { kind: "run_start", verified: true, status: null, started: false },
    };
  }

  const wait = describeRunWait(run, input.now);
  const facts = {
    runId: run.friendlyId,
    status: run.status,
    queue: run.queue,
    startedAt: run.startedAt?.toISOString() ?? null,
    queuedAt: run.queuedAt?.toISOString() ?? null,
    ...wait,
  };
  const observed: WatchObservedOutcome = {
    kind: "run_start",
    verified: true,
    status: run.status,
    started: run.startedAt !== null,
  };

  if (run.startedAt) return { result: "satisfied", facts, observed };
  if (isTerminalRunStatus(run.status)) {
    return {
      result: "terminal_unsatisfied",
      facts: { ...facts, reason: "never_started" },
      observed,
    };
  }
  return { result: "pending", facts, observed };
}

/**
 * Satisfied on any terminal status. Finished and failed are both `condition_met`, so only
 * `observed.finalStatus` separates them.
 */
export async function checkRunFinished(
  spec: Extract<WatchSpec, { kind: "run_finished" }>,
  deps: WatchCheckDeps,
  input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const run = await deps.readRun(spec.runId);
  if (!run) {
    return {
      result: "terminal_unsatisfied",
      facts: { runId: spec.runId, reason: "run_not_found" },
      observed: { kind: "run_finished", verified: true, finalStatus: null, durationMs: null },
    };
  }

  const finished = isTerminalRunStatus(run.status);
  // Execution duration only. The queue wait is reported separately.
  const durationMs =
    run.startedAt && run.completedAt
      ? Math.max(0, run.completedAt.getTime() - run.startedAt.getTime())
      : null;

  const wait = describeRunWait(run, input.now);
  const facts = {
    runId: run.friendlyId,
    outcome: run.status,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    durationMs,
    durationLabel: durationMs === null ? null : formatMs(durationMs),
    ...wait,
  };

  return {
    result: finished ? "satisfied" : "pending",
    facts,
    observed: {
      kind: "run_finished",
      verified: true,
      // Only a terminal status is a final status.
      finalStatus: finished ? run.status : null,
      durationMs,
    },
  };
}

/**
 * A failing terminal status satisfies this; a successful completion or a cancellation makes
 * the condition impossible rather than merely unmet.
 */
export async function checkRunFailed(
  spec: Extract<WatchSpec, { kind: "run_failed" }>,
  deps: WatchCheckDeps,
  input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const run = await deps.readRun(spec.runId);
  if (!run) {
    return {
      result: "terminal_unsatisfied",
      facts: { runId: spec.runId, reason: "run_not_found" },
      observed: { kind: "run_failed", verified: true, finalStatus: null, durationMs: null },
    };
  }

  const finished = isTerminalRunStatus(run.status);
  const durationMs =
    run.startedAt && run.completedAt
      ? Math.max(0, run.completedAt.getTime() - run.startedAt.getTime())
      : null;

  const wait = describeRunWait(run, input.now);
  const facts = {
    runId: run.friendlyId,
    outcome: run.status,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    durationMs,
    durationLabel: durationMs === null ? null : formatMs(durationMs),
    ...wait,
  };
  const observed: WatchObservedOutcome = {
    kind: "run_failed",
    verified: true,
    finalStatus: finished ? run.status : null,
    durationMs,
  };

  if (!finished) return { result: "pending", facts, observed };

  return {
    result: watchRunDisposition(run.status) === "failed" ? "satisfied" : "terminal_unsatisfied",
    facts: {
      ...facts,
      ...(watchRunDisposition(run.status) === "failed" ? {} : { reason: "cannot_fail_now" }),
    },
    observed,
  };
}

/**
 * The queue-depth read both threshold kinds share. A missing queue is `terminal_unsatisfied`,
 * an unreadable or stale-low depth is `unavailable`, and a stale-high one is approximate.
 */
async function readDepthOrOutcome(args: {
  queue: string;
  deps: WatchCheckDeps;
  /** The observation to record when there is no usable reading. */
  unobserved: (verified: boolean) => WatchObservedOutcome;
  /** A non-current reading at or under this is refused; one above it passes through. */
  quietLine: number;
  /**
   * Stateful kinds only: no non-current reading is usable, because a phantom sample would
   * enter the streak as if it had been observed now.
   */
  requireCurrent?: boolean;
}): Promise<
  | { ok: true; depth: WatchQueueDepth; facts: Record<string, unknown> }
  | { ok: false; outcome: WatchCheckOutcome }
> {
  const { queue, deps, unobserved, quietLine } = args;
  const depth = await deps.readQueueDepth(queue);

  if (depth === null) {
    // Only a missing queue is terminal, not an unreadable depth.
    const exists = await deps.queueExists(queue);
    if (!exists) {
      return {
        ok: false,
        outcome: {
          result: "terminal_unsatisfied",
          facts: { queue, reason: "queue_not_found" },
          observed: unobserved(true),
        },
      };
    }
    return {
      ok: false,
      outcome: {
        result: "unavailable",
        facts: { queue, reason: "depth_unavailable" },
        observed: unobserved(false),
      },
    };
  }

  const facts = {
    queue,
    depth: depth.depth,
    depthSource: depth.source,
    depthAsOf: depth.asOf?.toISOString() ?? null,
    depthApproximate: !depth.current,
  };

  // A claim of quiet needs a reading that describes now: a stale empty bucket is never
  // read as drained.
  if (!depth.current && (args.requireCurrent || depth.depth <= quietLine)) {
    return {
      ok: false,
      outcome: {
        result: "unavailable",
        facts: { ...facts, reason: "depth_stale" },
        observed: unobserved(false),
      },
    };
  }

  return { ok: true, depth, facts };
}

/**
 * Satisfied when the queue's current pending count is 0. The observation carries the depth
 * read, so a window completing without a drain needs no second read.
 */
export async function checkBacklogDrain(
  spec: Extract<WatchSpec, { kind: "backlog_drain" }>,
  deps: WatchCheckDeps,
  _input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const read = await readDepthOrOutcome({
    queue: spec.queue,
    deps,
    unobserved: (verified) => ({ kind: "backlog_drain", verified, depth: null }),
    quietLine: 0,
  });
  if (!read.ok) return read.outcome;

  return {
    result: read.depth.depth === 0 ? "satisfied" : "pending",
    facts: read.facts,
    observed: { kind: "backlog_drain", verified: true, depth: read.depth.depth },
  };
}

/**
 * Satisfied when the pending count rises above `threshold`. No `terminal_unsatisfied` on a
 * live queue: only the queue disappearing makes the condition impossible.
 */
export async function checkQueueDepthAbove(
  spec: Extract<WatchSpec, { kind: "queue_depth_above" }>,
  deps: WatchCheckDeps,
  _input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const read = await readDepthOrOutcome({
    queue: spec.queue,
    deps,
    unobserved: (verified) => ({
      kind: "queue_depth_above",
      verified,
      depth: null,
      threshold: spec.threshold,
    }),
    quietLine: spec.threshold,
  });
  if (!read.ok) return read.outcome;

  return {
    result: read.depth.depth > spec.threshold ? "satisfied" : "pending",
    facts: { ...read.facts, threshold: spec.threshold },
    observed: {
      kind: "queue_depth_above",
      verified: true,
      depth: read.depth.depth,
      threshold: spec.threshold,
    },
  };
}

/**
 * The mirror of `queue_depth_above`: satisfied at or under `threshold`, which is also the quiet
 * line for the freshness fence. Only the queue disappearing is terminal.
 */
export async function checkQueueDepthBelow(
  spec: Extract<WatchSpec, { kind: "queue_depth_below" }>,
  deps: WatchCheckDeps,
  _input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const read = await readDepthOrOutcome({
    queue: spec.queue,
    deps,
    unobserved: (verified) => ({
      kind: "queue_depth_below",
      verified,
      depth: null,
      threshold: spec.threshold,
    }),
    quietLine: spec.threshold,
  });
  if (!read.ok) return read.outcome;

  return {
    result: read.depth.depth <= spec.threshold ? "satisfied" : "pending",
    facts: { ...read.facts, threshold: spec.threshold },
    observed: {
      kind: "queue_depth_below",
      verified: true,
      depth: read.depth.depth,
      threshold: spec.threshold,
    },
  };
}

/** The stall state one check hands the next, read out of the previous facts. */
type WatchStallState = { depth: number; notDecreasingStreak: number };

function readStallState(
  previous: Record<string, unknown> | null | undefined
): WatchStallState | null {
  if (!previous) return null;
  const depth = previous.depth;
  if (typeof depth !== "number" || !Number.isFinite(depth)) return null;
  const streak = previous.notDecreasingStreak;
  return {
    depth,
    notDecreasingStreak: typeof streak === "number" && Number.isFinite(streak) ? streak : 0,
  };
}

/**
 * Satisfied when the depth fails to decrease for `ticks` consecutive checks with runs queued.
 * The streak lives only in `input.previous`, a gap freezes it, and depth 0 resets it.
 */
export async function checkQueueStalled(
  spec: Extract<WatchSpec, { kind: "queue_stalled" }>,
  deps: WatchCheckDeps,
  input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const previous = readStallState(input.previous);
  const read = await readDepthOrOutcome({
    queue: spec.queue,
    deps,
    unobserved: (verified) => ({
      kind: "queue_stalled",
      verified,
      depth: null,
      // Carry the streak through an unusable check.
      notDecreasingStreak: previous?.notDecreasingStreak ?? 0,
      ticks: spec.ticks,
    }),
    quietLine: 0,
    requireCurrent: true,
  });
  if (!read.ok) return read.outcome;

  const depth = read.depth.depth;
  // A first observation has nothing to compare against, so it isn't a stalled tick.
  const notDecreasingStreak =
    depth === 0 || previous === null
      ? 0
      : depth >= previous.depth
        ? previous.notDecreasingStreak + 1
        : 0;

  const facts = {
    ...read.facts,
    previousDepth: previous?.depth ?? null,
    notDecreasingStreak,
    ticks: spec.ticks,
  };

  return {
    result: depth > 0 && notDecreasingStreak >= spec.ticks ? "satisfied" : "pending",
    facts,
    observed: {
      kind: "queue_stalled",
      verified: true,
      depth,
      notDecreasingStreak,
      ticks: spec.ticks,
    },
  };
}

/**
 * Satisfied when the oldest waiting run has waited longer than the SLA. Any stale reading is
 * `unavailable` rather than compared, and an empty queue is `pending`.
 */
export async function checkQueueOldestAge(
  spec: Extract<WatchSpec, { kind: "queue_oldest_age" }>,
  deps: WatchCheckDeps,
  _input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const thresholdMs = spec.thresholdMinutes * 60_000;
  const unobserved = (verified: boolean): WatchObservedOutcome => ({
    kind: "queue_oldest_age",
    verified,
    ageMs: null,
    thresholdMinutes: spec.thresholdMinutes,
  });

  const reading = await deps.readQueueOldestAge(spec.queue);

  if (reading === null) {
    const exists = await deps.queueExists(spec.queue);
    if (!exists) {
      return {
        result: "terminal_unsatisfied",
        facts: { queue: spec.queue, reason: "queue_not_found" },
        observed: unobserved(true),
      };
    }
    return {
      result: "unavailable",
      facts: { queue: spec.queue, reason: "age_unavailable" },
      observed: unobserved(false),
    };
  }

  const facts = {
    queue: spec.queue,
    ageMs: reading.ageMs,
    ageLabel: reading.ageMs === null ? null : formatMs(reading.ageMs),
    ageSource: reading.source,
    ageAsOf: reading.asOf?.toISOString() ?? null,
    thresholdMinutes: spec.thresholdMinutes,
  };

  if (!reading.current) {
    return {
      result: "unavailable",
      facts: { ...facts, reason: "age_stale" },
      observed: unobserved(false),
    };
  }

  const observed: WatchObservedOutcome = {
    kind: "queue_oldest_age",
    verified: true,
    ageMs: reading.ageMs,
    thresholdMinutes: spec.thresholdMinutes,
  };

  return {
    result: reading.ageMs !== null && reading.ageMs > thresholdMs ? "satisfied" : "pending",
    facts,
    observed,
  };
}

/**
 * The model cites the API error id (`error_<fingerprint>`) but ClickHouse stores the raw
 * fingerprint. Same normalization the errors API route uses.
 */
export function normalizeErrorFingerprint(fingerprint: string): string {
  return ErrorId.toId(fingerprint);
}

/**
 * Satisfied on the first occurrence proven to be after the server-set `since`, which is
 * never caller-set. The facts carry the precision of what they claim.
 */
export async function checkErrorRecurrence(
  spec: Extract<WatchSpec, { kind: "error_recurrence" }>,
  deps: WatchCheckDeps,
  input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const fingerprint = normalizeErrorFingerprint(spec.fingerprint);
  const recurrence = await deps.readErrorRecurrence(fingerprint, input.since);
  const base = { fingerprint, since: input.since.toISOString() };

  const quiet: WatchObservedOutcome = {
    kind: "error_recurrence",
    verified: true,
    countSince: 0,
  };

  if (!recurrence) {
    return {
      result: "pending",
      facts: { ...base, countSince: 0, lastSeenAt: null },
      observed: quiet,
    };
  }

  const lastSeenAt = recurrence.lastSeenAt?.toISOString() ?? null;

  if (!recurrence.occurredAt) {
    return {
      result: "pending",
      facts: { ...base, countSince: 0, lastSeenAt },
      observed: quiet,
    };
  }

  return {
    result: "satisfied",
    facts: {
      ...base,
      occurredAt: recurrence.occurredAt.toISOString(),
      occurredAtPrecision: recurrence.occurredAtPrecision,
      countSince: recurrence.countSince,
      countApproximate: recurrence.countApproximate,
      lastSeenAt,
    },
    observed: {
      kind: "error_recurrence",
      verified: true,
      countSince: recurrence.countSince,
    },
  };
}

/**
 * Satisfied only when the health report is both trustworthy and `ok`. An untrustworthy
 * report can never fire a recovery.
 */
export async function checkHealthRecovery(
  spec: Extract<WatchSpec, { kind: "health_recovery" }>,
  deps: WatchCheckDeps,
  _input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const health = await deps.readHealth();
  if (!health) {
    return {
      result: "unavailable",
      facts: { report: spec.report, reason: "report_unavailable" },
      observed: { kind: "health_recovery", verified: false, severity: null },
    };
  }

  const facts = {
    report: spec.report,
    fromSeverity: spec.fromSeverity,
    severity: health.severity,
    trustworthy: health.trustworthy,
  };

  if (!health.trustworthy) {
    // An untrustworthy report is not an observation of the severity, so record none.
    return {
      result: "pending",
      facts: { ...facts, reason: "untrustworthy" },
      observed: { kind: "health_recovery", verified: false, severity: null },
    };
  }

  return {
    result: health.severity === "ok" ? "satisfied" : "pending",
    facts,
    observed: { kind: "health_recovery", verified: true, severity: health.severity },
  };
}

/** The single place a check failure becomes `unavailable`, never a verdict. */
export async function checkWatch(
  spec: WatchSpec,
  deps: WatchCheckDeps,
  input: WatchCheckInput,
  onError?: (error: unknown) => void
): Promise<WatchCheckOutcome> {
  try {
    switch (spec.kind) {
      case "run_start":
        return await checkRunStart(spec, deps, input);
      case "run_finished":
        return await checkRunFinished(spec, deps, input);
      case "run_failed":
        return await checkRunFailed(spec, deps, input);
      case "backlog_drain":
        return await checkBacklogDrain(spec, deps, input);
      case "queue_depth_above":
        return await checkQueueDepthAbove(spec, deps, input);
      case "queue_depth_below":
        return await checkQueueDepthBelow(spec, deps, input);
      case "queue_stalled":
        return await checkQueueStalled(spec, deps, input);
      case "queue_oldest_age":
        return await checkQueueOldestAge(spec, deps, input);
      case "error_recurrence":
        return await checkErrorRecurrence(spec, deps, input);
      case "health_recovery":
        return await checkHealthRecovery(spec, deps, input);
      default: {
        const unreachable: never = spec;
        throw new Error(`Unhandled watch kind: ${JSON.stringify(unreachable)}`);
      }
    }
  } catch (error) {
    onError?.(error);
    return {
      result: "unavailable",
      facts: { kind: spec.kind, reason: "check_failed" },
      observed: unobservedOutcome(spec),
    };
  }
}

/**
 * The observation for a check that couldn't run. `verified: false` means the condition
 * couldn't be confirmed, not that it didn't happen.
 */
export function unobservedOutcome(spec: WatchSpec): WatchObservedOutcome {
  switch (spec.kind) {
    case "run_start":
      return { kind: "run_start", verified: false, status: null, started: false };
    case "run_finished":
      return { kind: "run_finished", verified: false, finalStatus: null, durationMs: null };
    case "run_failed":
      return { kind: "run_failed", verified: false, finalStatus: null, durationMs: null };
    case "backlog_drain":
      return { kind: "backlog_drain", verified: false, depth: null };
    case "queue_depth_above":
      return {
        kind: "queue_depth_above",
        verified: false,
        depth: null,
        threshold: spec.threshold,
      };
    case "queue_depth_below":
      return {
        kind: "queue_depth_below",
        verified: false,
        depth: null,
        threshold: spec.threshold,
      };
    case "queue_stalled":
      return {
        kind: "queue_stalled",
        verified: false,
        depth: null,
        notDecreasingStreak: 0,
        ticks: spec.ticks,
      };
    case "queue_oldest_age":
      return {
        kind: "queue_oldest_age",
        verified: false,
        ageMs: null,
        thresholdMinutes: spec.thresholdMinutes,
      };
    case "error_recurrence":
      return { kind: "error_recurrence", verified: false, countSince: 0 };
    case "health_recovery":
      return { kind: "health_recovery", verified: false, severity: null };
    default: {
      const unreachable: never = spec;
      throw new Error(`Unhandled watch kind: ${JSON.stringify(unreachable)}`);
    }
  }
}
