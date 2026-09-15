/**
 * Deterministic evaluation of one watch condition, with IO behind `WatchCheckDeps`. `unavailable`
 * is never a verdict, durations carry their basis, and `observed` is kept apart from the result.
 *
 * One module per condition family; this one dispatches and owns the failure envelope.
 */

import type { WatchObservedOutcome, WatchSpec } from "@internal/dashboard-agent-contracts";
import type {
  WatchCheckDeps,
  WatchCheckInput,
  WatchCheckOutcome,
} from "./dashboardAgentWatchCheckBase";
import { checkRunFailed, checkRunFinished, checkRunStart } from "./dashboardAgentWatchRunChecks";
import {
  checkBacklogDrain,
  checkQueueDepthAbove,
  checkQueueDepthBelow,
  checkQueueOldestAge,
  checkQueueStalled,
} from "./dashboardAgentWatchQueueChecks";
import { checkErrorRecurrence } from "./dashboardAgentWatchErrorChecks";
import { checkHealthRecovery } from "./dashboardAgentWatchHealthChecks";

export type {
  WatchCheckDeps,
  WatchCheckInput,
  WatchCheckOutcome,
  WatchErrorRecurrence,
  WatchHealthSeverity,
  WatchHealthSnapshot,
  WatchQueueDepth,
  WatchQueueOldestAge,
  WatchRunRow,
} from "./dashboardAgentWatchCheckBase";

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
function unobservedOutcome(spec: WatchSpec): WatchObservedOutcome {
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
