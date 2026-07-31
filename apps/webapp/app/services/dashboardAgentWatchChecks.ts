/**
 * Watch checks — the DETERMINISTIC evaluation of one watch condition. No LLM
 * anywhere in this file, and no transport: IO lives behind `WatchCheckDeps` so
 * tests inject plain fake readers (same shape as `waitingRunDiagnosis.ts`).
 *
 * Every check answers with one of four values (see the contract in
 * `@internal/dashboard-agent-contracts`):
 *   pending · satisfied · terminal_unsatisfied · unavailable
 *
 * Two rules hold for all of them:
 *
 * 1. **`unavailable` is never a verdict.** A reader that throws, or data that
 *    can't be read, yields `unavailable` — never `pending` (which would quietly
 *    burn the watch's lifetime on a broken data source) and never `satisfied`.
 * 2. **`facts` are the numbers the wake narration reads.** They are computed
 *    here, deterministically, so the model never has to derive a duration or a
 *    depth itself. Durations carry their BASIS (VERDICTS.md §4): a wait is only
 *    labelled a queue wait when `queuedAt` exists.
 */

import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3/utils/durations";
import type { WatchCheckResult, WatchSpec } from "@internal/dashboard-agent-contracts";

// ---------------------------------------------------------------------------
// Inputs — plain data, no Prisma / ClickHouse types.
// ---------------------------------------------------------------------------

/** The single run point-read. Postgres is authoritative for run state. */
export type WatchRunRow = {
  friendlyId: string;
  status: string;
  queue: string;
  createdAt: Date;
  /** Stamped when the run entered the queue. NULL while a run is delayed. */
  queuedAt: Date | null;
  /** Set once the run is dequeued — the run has started. */
  startedAt: Date | null;
  completedAt: Date | null;
  delayUntil: Date | null;
};

export type WatchQueueDepth = {
  /** Pending count for the queue, as of `asOf`. */
  depth: number;
  source: "live_queue" | "queue_metrics";
  /**
   * Whether the reading describes the queue RIGHT NOW. A live counter always
   * does; an analytics bucket only does while it's fresh enough to cover the
   * present. A stale reading can never answer "drained" — see
   * `checkBacklogDrain`.
   */
  current: boolean;
  /** What instant the reading describes, when it isn't the live counter. */
  asOf?: Date;
};

/** What we know about the watched error's occurrences relative to `since`. */
export type WatchErrorRecurrence = {
  /**
   * The earliest occurrence PROVEN to be after `since`, or null when nothing has
   * recurred. Null with a `lastSeenAt` means "seen before, not since".
   */
  occurredAt: Date | null;
  /** How precisely `occurredAt` is known: to the millisecond, or to its minute. */
  occurredAtPrecision: "exact" | "minute" | null;
  /** Occurrences after `since`. A LOWER BOUND when `countApproximate`. */
  countSince: number;
  /**
   * True when `countSince` can't be split exactly — occurrences in the minute
   * the watch was created can't be told apart from the error that prompted it.
   */
  countApproximate: boolean;
  /** The fingerprint's most recent occurrence, whenever it was. */
  lastSeenAt: Date | null;
};

export type WatchHealthSeverity = "ok" | "warn" | "crit";

export type WatchHealthSnapshot = {
  /** `facts.trustworthy` from the health report. Untrustworthy NEVER fires recovery. */
  trustworthy: boolean;
  severity: WatchHealthSeverity;
};

/**
 * The readers a check may use. Each may throw — the caller turns that into
 * `unavailable`. Returning `null` means "the data source answered, and there is
 * nothing there", which each check interprets on its own terms.
 */
export type WatchCheckDeps = {
  /** Run point-read by public run id, scoped to the watch's environment. */
  readRun: (runId: string) => Promise<WatchRunRow | null>;
  /** Does this queue exist in the watch's environment? */
  queueExists: (queue: string) => Promise<boolean>;
  /** Current pending count, live run-queue first with a ClickHouse fallback. */
  readQueueDepth: (queue: string) => Promise<WatchQueueDepth | null>;
  /**
   * What's known about `fingerprint` relative to `since`. `null` means the
   * fingerprint has no occurrences at all in this environment.
   */
  readErrorRecurrence: (fingerprint: string, since: Date) => Promise<WatchErrorRecurrence | null>;
  /** The health report's current verdict for the watch's environment. */
  readHealth: () => Promise<WatchHealthSnapshot | null>;
};

export type WatchCheckInput = {
  /** Evaluation clock — injected so durations are testable. */
  now: Date;
  /**
   * The recurrence window's start for `error_recurrence`: the server-set
   * `spec.since`, falling back to the watch row's `createdAt`. Never caller-set.
   */
  since: Date;
};

export type WatchCheckOutcome = {
  result: WatchCheckResult;
  facts: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Run status vocabulary (mirrors ~/v3/taskStatus, kept local so this module has
// no server-side import and stays trivially testable).
// ---------------------------------------------------------------------------

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
 * Statuses whose `queuedAt` is a stale leftover from the FIRST enqueue
 * (resume/retry re-enqueues don't restamp it), so a wait computed from it isn't
 * this attempt's queue wait — VERDICTS.md §4.
 */
const STALE_QUEUED_AT_STATUSES = new Set(["WAITING_TO_RESUME", "RETRYING_AFTER_FAILURE", "PAUSED"]);

export function isTerminalRunStatus(status: string): boolean {
  return FINAL_STATUSES.has(status);
}

function formatMs(ms: number): string {
  return formatDurationMilliseconds(ms, { style: "short", maxDecimalPoints: 0 });
}

/** Which timestamp a wait was measured from — the label's honesty guarantee. */
export type WatchWaitBasis = "queued_at" | "delay_until" | "created_at";

/**
 * The wait a run has accumulated, with the ONLY label the data supports: a
 * `queuedAt` that belongs to THIS attempt -> a real queue wait; a future
 * `delayUntil` -> a schedule, not latency; otherwise time from creation, said out
 * loud.
 *
 * A resumed/retried/paused run's `queuedAt` is a leftover from the first enqueue,
 * so it is not measured from at all: a number that isn't this attempt's queue
 * wait must never be worded as one, even with a flag next to it.
 */
export function describeRunWait(
  run: WatchRunRow,
  now: Date
): {
  waitMs: number | null;
  waitBasis: WatchWaitBasis;
  waitLabel: string;
  /** True only when the wait IS this attempt's queue wait. */
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

  // Either there is no `queuedAt`, or the one we have belongs to an earlier
  // attempt. Both fall back to the run's age, and say that's what it is.
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

// ---------------------------------------------------------------------------
// One function per WatchSpec kind.
// ---------------------------------------------------------------------------

/**
 * run_start — satisfied the moment `startedAt` exists, whatever the run's CURRENT
 * status is: a run that started and then failed still started, and the user asked
 * about the start. Terminal with no `startedAt` (cancelled/expired while queued)
 * can never start, so it's `terminal_unsatisfied`.
 */
export async function checkRunStart(
  spec: Extract<WatchSpec, { kind: "run_start" }>,
  deps: WatchCheckDeps,
  input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const run = await deps.readRun(spec.runId);
  if (!run) {
    // Existence was validated when the watch was created, so absence now means
    // the run is gone from this environment — it can never start.
    return {
      result: "terminal_unsatisfied",
      facts: { runId: spec.runId, reason: "run_not_found" },
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

  if (run.startedAt) return { result: "satisfied", facts };
  if (isTerminalRunStatus(run.status)) {
    return { result: "terminal_unsatisfied", facts: { ...facts, reason: "never_started" } };
  }
  return { result: "pending", facts };
}

/** run_finished — satisfied on any terminal status; facts carry outcome + duration. */
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
    };
  }

  const finished = isTerminalRunStatus(run.status);
  // Execution duration only — startedAt -> completedAt. A run that never started
  // has no duration, and the queue wait is reported separately.
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

  return { result: finished ? "satisfied" : "pending", facts };
}

/**
 * backlog_drain — satisfied when the queue's current pending count is 0. A queue
 * that no longer exists can never drain in an observable sense, so that's
 * `terminal_unsatisfied`; a depth we can't read is `unavailable`, never "drained".
 *
 * A zero needs a reading that describes NOW (`current`): a stale analytics bucket
 * that happened to be empty says nothing about the runs queued after it, so it's
 * `unavailable` too. A stale NON-zero depth is still worth reporting — the queue
 * demonstrably wasn't empty — and is marked approximate.
 */
export async function checkBacklogDrain(
  spec: Extract<WatchSpec, { kind: "backlog_drain" }>,
  deps: WatchCheckDeps,
  _input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const depth = await deps.readQueueDepth(spec.queue);

  if (depth === null) {
    // Distinguish "no such queue" from "couldn't read the depth" — only the
    // former is terminal.
    const exists = await deps.queueExists(spec.queue);
    if (!exists) {
      return {
        result: "terminal_unsatisfied",
        facts: { queue: spec.queue, reason: "queue_not_found" },
      };
    }
    return { result: "unavailable", facts: { queue: spec.queue, reason: "depth_unavailable" } };
  }

  const facts = {
    queue: spec.queue,
    depth: depth.depth,
    depthSource: depth.source,
    depthAsOf: depth.asOf?.toISOString() ?? null,
    depthApproximate: !depth.current,
  };

  if (depth.depth === 0 && !depth.current) {
    return { result: "unavailable", facts: { ...facts, reason: "depth_stale" } };
  }

  return { result: depth.depth === 0 ? "satisfied" : "pending", facts };
}

/**
 * The model cites the API error id (`error_<fingerprint>`), but ClickHouse stores
 * the raw fingerprint — same normalization the errors API route uses. Raw
 * fingerprints pass through unchanged.
 */
export function normalizeErrorFingerprint(fingerprint: string): string {
  return ErrorId.toId(fingerprint);
}

/**
 * error_recurrence — satisfied on the first occurrence proven to be after the
 * server-set `since`. `since` is never caller-set, so the model can't backdate the
 * window and make a pre-existing error look like a recurrence.
 *
 * The facts carry the PRECISION of what they claim (`occurredAtPrecision`,
 * `countApproximate`) and, when nothing recurred, when the error was last seen —
 * so the wake narration can't assert more than the data supports.
 */
export async function checkErrorRecurrence(
  spec: Extract<WatchSpec, { kind: "error_recurrence" }>,
  deps: WatchCheckDeps,
  input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const fingerprint = normalizeErrorFingerprint(spec.fingerprint);
  const recurrence = await deps.readErrorRecurrence(fingerprint, input.since);
  const base = { fingerprint, since: input.since.toISOString() };

  if (!recurrence) {
    return { result: "pending", facts: { ...base, countSince: 0, lastSeenAt: null } };
  }

  const lastSeenAt = recurrence.lastSeenAt?.toISOString() ?? null;

  if (!recurrence.occurredAt) {
    return { result: "pending", facts: { ...base, countSince: 0, lastSeenAt } };
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
  };
}

/**
 * health_recovery — satisfied only when the health report is BOTH trustworthy and
 * `ok`. Stale telemetry marks the report untrustworthy, and an untrustworthy
 * report can never fire a recovery: "looks fine" off stale data is exactly the
 * false all-clear this watch exists to avoid.
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
    };
  }

  const facts = {
    report: spec.report,
    fromSeverity: spec.fromSeverity,
    severity: health.severity,
    trustworthy: health.trustworthy,
  };

  if (!health.trustworthy) {
    return { result: "pending", facts: { ...facts, reason: "untrustworthy" } };
  }

  return { result: health.severity === "ok" ? "satisfied" : "pending", facts };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Evaluate one watch. The single place a check failure becomes `unavailable`:
 * every reader may throw and nothing here turns a broken data source into a
 * verdict.
 */
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
      case "backlog_drain":
        return await checkBacklogDrain(spec, deps, input);
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
    return { result: "unavailable", facts: { kind: spec.kind, reason: "check_failed" } };
  }
}
