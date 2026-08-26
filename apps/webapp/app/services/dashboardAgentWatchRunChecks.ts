/**
 * The run condition family: start, finished, failed. All three read one run row and
 * label the wait with what the data actually supports.
 */

import {
  watchRunDisposition,
  type WatchObservedOutcome,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";
import {
  formatMs,
  type WatchCheckDeps,
  type WatchCheckInput,
  type WatchCheckOutcome,
  type WatchRunRow,
} from "./dashboardAgentWatchCheckBase";

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
 * re-enqueues don't restamp it, so a wait computed from it isn't this attempt's. Exported
 * so other run-facing readers can derive the same reliability signal from the raw status
 * instead of re-deriving it.
 */
export const STALE_QUEUED_AT_STATUSES = new Set([
  "WAITING_TO_RESUME",
  "RETRYING_AFTER_FAILURE",
  "PAUSED",
]);

function isTerminalRunStatus(status: string): boolean {
  return FINAL_STATUSES.has(status);
}

/** Which timestamp a wait was measured from. */
type WatchWaitBasis = "queued_at" | "delay_until" | "created_at";

/**
 * The wait a run has accumulated, labelled with what the data supports. A resumed, retried or
 * paused run's stale `queuedAt` is never measured from.
 */
function describeRunWait(
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
