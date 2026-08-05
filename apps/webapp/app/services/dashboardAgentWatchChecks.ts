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
 *    depth itself. Durations carry their BASIS: a wait is only
 *    labelled a queue wait when `queuedAt` exists.
 * 3. **`observed` is what the check SAW**, in the contracts' per-kind shape. It is
 *    the second half of a resolved result: the resolution says how the watch
 *    ended, the observation says what was true when it did — and the presentation
 *    needs both (§4.2). `run_finished` is the clearest case: the reader preserves
 *    the final status, so a completion WITH FAILURE presents as attention rather
 *    than as the success its `condition_met` resolution would otherwise imply.
 */

import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3/utils/durations";
import {
  watchRunDisposition,
  type WatchCheckResult,
  type WatchObservedOutcome,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";

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

/**
 * The oldest still-waiting run's age in one queue — the same signal the queue
 * page's **Oldest wait** block shows.
 *
 * `current` carries the same meaning as on a depth reading, and matters more here:
 * an age read minutes ago is wrong in BOTH directions (the run may have started,
 * or it may have aged past the SLA since), so `checkQueueOldestAge` refuses a
 * non-current reading outright rather than comparing it to a threshold.
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
  /** Age of the oldest run still waiting in the queue, right now. */
  readQueueOldestAge: (queue: string) => Promise<WatchQueueOldestAge | null>;
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
  /**
   * The PREVIOUS check's facts, for the stateful kinds — the generic seam every
   * future "K consecutive ticks" condition reuses (§9.1).
   *
   * State lives in the facts a check emits, which the existing `recordWatchCheck`
   * already persists on the row: no new column, and no check may keep state
   * anywhere else. Extract it from the row with {@link previousCheckFacts}, which
   * is also what enforces the binding rule — a tick that couldn't read anything
   * never becomes the previous observation, so a data gap freezes a streak instead
   * of resetting it.
   *
   * Absent (creation-time check, first tick, a stateless kind) means "no prior
   * observation", never "zero".
   */
  previous?: Record<string, unknown> | null;
};

/**
 * The previous check's FACTS, dug out of whatever the row's `lastResult` holds.
 *
 * Three shapes reach that column and this is the one place that knows all three:
 * the tick's raw facts (a `pending` tick), the check endpoint's
 * `{ result, facts, observed, final }` envelope, and the tick's failure wrapper
 * `{ checkFailed: true, previous }`.
 *
 * The wrapper is UNWRAPPED rather than read: an `unavailable` tick observed
 * nothing, so the last real observation stays the previous one and a streak
 * neither grows nor resets across the gap (§9.1, binding).
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
  /**
   * What this check observed, in the contracts' per-kind shape. Frozen onto the
   * row by the resolving transition, so every delivery surface reads the same
   * observation and none of them re-reads the source (§7.5).
   */
  observed: WatchObservedOutcome;
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
 * this attempt's queue wait.
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
 * run_finished — satisfied on ANY terminal status, and the observation PRESERVES
 * that status. The resolution alone cannot tell "Run abc123 finished" from "Run
 * abc123 failed": both are `condition_met`, and only `observed.finalStatus`
 * separates them (§4.2, §7.4). The reader never filters on status — a watch on a
 * run that fails is still answered, just presented as attention.
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

  return {
    result: finished ? "satisfied" : "pending",
    facts,
    observed: {
      kind: "run_finished",
      verified: true,
      // Only a terminal status is a FINAL status. A running run has no verdict yet.
      finalStatus: finished ? run.status : null,
      durationMs,
    },
  };
}

/**
 * run_failed — the same point read as `run_finished`, asked the other way round.
 *
 * The asymmetry is the whole point: a FAILING terminal status satisfies it, while
 * a run that completes successfully makes the condition impossible rather than
 * merely unmet — it can never fail now, and that is the good news the mapping
 * presents (§4.2). A cancellation is neither, so it is also terminal: the run will
 * not fail, and the presentation says it was cancelled rather than claiming a win.
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
 * The queue-depth read both threshold kinds share, resolved down to either a
 * usable reading or the outcome that replaces it.
 *
 * A queue that no longer exists can never be observed, so that is
 * `terminal_unsatisfied`; a depth we can't read is `unavailable`, never a number.
 * The freshness fence lives here too: a stale analytics bucket says nothing about
 * the runs queued after it, so a zero from one is `unavailable`. A stale NON-zero
 * depth is still worth reporting — the queue demonstrably wasn't empty — and is
 * marked approximate.
 */
async function readDepthOrOutcome(args: {
  queue: string;
  deps: WatchCheckDeps;
  /** The observation to record when there is no usable reading. */
  unobserved: (verified: boolean) => WatchObservedOutcome;
  /**
   * The line below which a reading claims the queue is QUIET. A non-current
   * reading at or under it is refused: a stale bucket can no more prove "back
   * below 100" than it can prove "drained" (0 is the drain watch's line). A stale
   * reading ABOVE the line is still evidence the queue wasn't quiet, and passes
   * through marked approximate.
   */
  quietLine: number;
  /**
   * Stateful kinds only: no non-current reading is usable at all, because a phantom
   * sample would enter the streak as if it had been observed now.
   */
  requireCurrent?: boolean;
}): Promise<
  | { ok: true; depth: WatchQueueDepth; facts: Record<string, unknown> }
  | { ok: false; outcome: WatchCheckOutcome }
> {
  const { queue, deps, unobserved, quietLine } = args;
  const depth = await deps.readQueueDepth(queue);

  if (depth === null) {
    // Distinguish "no such queue" from "couldn't read the depth" — only the
    // former is terminal.
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

  // A claim of quiet needs a reading that describes NOW. Reading a stale empty
  // bucket as "drained" (or a stale low one as "back below the threshold") is the
  // one mistake these must never make.
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
 * backlog_drain — satisfied when the queue's current pending count is 0.
 *
 * The observation carries the depth the resolving check read, so a window that
 * completes without a drain can say HOW backed up the queue still was without
 * going back to the source.
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
 * queue_depth_above — the SAME depth reader with the comparison inverted:
 * satisfied when the pending count rises ABOVE `threshold`. No new IO, and the
 * freshness fence is shared verbatim, so a stale bucket can no more prove "still
 * below" than it can prove "drained".
 *
 * Deliberately no `terminal_unsatisfied` on a live queue: a queue that is quiet
 * now can grow at any moment, which is exactly what this watch is for. Only the
 * queue disappearing makes the condition impossible.
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
 * queue_depth_below — the mirror of `queue_depth_above` on the same reader:
 * satisfied when the pending count comes back down to `threshold` or under it.
 *
 * "Back below N" is not "drained": a busy queue may never reach zero, and the
 * question is whether it is usable again. The freshness fence is the shared one,
 * with the threshold as the quiet line — a stale reading that LOOKS low proves
 * nothing about the runs queued after it, so it is `unavailable`, not an answer.
 *
 * Like the `above` variant there is no `terminal_unsatisfied` on a live queue: a
 * backed-up queue can drop at any moment. Only the queue disappearing makes the
 * condition impossible.
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
 * queue_stalled — satisfied when the depth has failed to decrease for `ticks`
 * consecutive checks with runs still queued. The FIRST stateful kind, and the
 * shape every later "K consecutive ticks" condition copies.
 *
 * Three rules make the state honest:
 *
 * 1. **State is a fact, not a counter.** The streak is emitted in the facts and
 *    handed back as `input.previous`, so the row's existing `lastResult` is the
 *    only storage and a re-run of the same generation recomputes the same answer.
 * 2. **A gap freezes the streak.** `input.previous` is the last REAL observation
 *    (see `previousCheckFacts`), so a data gap neither grows nor resets it: the
 *    next usable reading compares against the depth before the gap.
 * 3. **A stale reading is not a sample.** `requireCurrent` refuses it, because a
 *    phantom sample would either invent a stall or wipe a real one.
 *
 * An EMPTY queue is not stalled — it drained, which is the opposite news — so
 * depth 0 resets the streak and stays pending.
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
      // The streak is carried through an unusable check so the frozen facts of a
      // window completion still say how close it had come.
      notDecreasingStreak: previous?.notDecreasingStreak ?? 0,
      ticks: spec.ticks,
    }),
    quietLine: 0,
    requireCurrent: true,
  });
  if (!read.ok) return read.outcome;

  const depth = read.depth.depth;
  // No comparison yet (first observation) is not a stalled tick: the streak counts
  // checks that watched the depth FAIL to fall, so it starts at zero.
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
 * queue_oldest_age — satisfied when the oldest run still waiting has been waiting
 * longer than the SLA.
 *
 * The honesty rule is stricter than the depth reader's: a non-current age is wrong
 * in both directions (the run may have started, or aged past the SLA since), so
 * ANY stale reading is `unavailable` rather than compared. An empty queue is
 * `pending`, not satisfied and not impossible — nothing is waiting, and something
 * may be a minute from now.
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
    // An untrustworthy report is not an observation of the severity: recording it
    // would let a window completion cite a severity nobody could stand behind.
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
 * The "we saw nothing" observation for a check that couldn't run. `verified:
 * false` is what makes a window completion say the condition couldn't be
 * confirmed, instead of claiming it didn't happen (§4.2).
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
