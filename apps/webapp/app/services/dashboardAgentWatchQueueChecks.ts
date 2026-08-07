/**
 * The queue condition family: drain, the two depth thresholds, stall and oldest age.
 * They share one freshness fence — a claim of quiet needs a reading that describes now.
 */

import type { WatchObservedOutcome, WatchSpec } from "@internal/dashboard-agent-contracts";
import {
  formatMs,
  type WatchCheckDeps,
  type WatchCheckInput,
  type WatchCheckOutcome,
  type WatchQueueDepth,
} from "./dashboardAgentWatchCheckBase";

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

  const gone = (): WatchCheckOutcome => ({
    result: "terminal_unsatisfied",
    facts: { queue: spec.queue, reason: "queue_not_found" },
    observed: unobserved(true),
  });

  const reading = await deps.readQueueOldestAge(spec.queue);

  if (reading === null) {
    if (!(await deps.queueExists(spec.queue))) return gone();
    return {
      result: "unavailable",
      facts: { queue: spec.queue, reason: "age_unavailable" },
      observed: unobserved(false),
    };
  }

  // Nothing waiting reads the same as a deleted queue, and only the second is terminal.
  if (reading.ageMs === null && !(await deps.queueExists(spec.queue))) return gone();

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
