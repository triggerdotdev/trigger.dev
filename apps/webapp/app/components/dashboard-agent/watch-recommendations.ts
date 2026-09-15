import {
  WATCH_DEFAULT_QUEUE_AGE_MINUTES,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";
import { OLDEST_WAIT_WARNING_MS } from "~/components/queues/queue-thresholds";
import { noteFor } from "~/presenters/v3/dashboardAgent";

/** Distributes over the spec union, so the kind stays discriminated. */
type WithoutNote<T> = T extends unknown ? Omit<T, "note"> : never;

/** The note comes from the presenter, so a recommendation reads like an edited one. */
function withNote(spec: WithoutNote<WatchSpec>): WatchSpec {
  const draft = { ...spec, note: "" } as WatchSpec;
  return { ...draft, note: noteFor(draft) };
}

export function runWatchRecommendation(runFriendlyId: string): WatchSpec {
  return withNote({
    kind: "run_finished",
    runId: runFriendlyId,
    checkEveryMinutes: 1,
    maxHours: 1,
  });
}

/**
 * The recommendation must be a condition that isn't true yet: an already-true watch
 * one-shots instead of watching. Past the wait threshold that means the drain, not the SLA.
 */
export function queueWatchRecommendation(
  queueName: string,
  context?: { oldestWaitMs?: number | null }
): WatchSpec {
  const oldestWaitMs = context?.oldestWaitMs ?? null;
  if (oldestWaitMs !== null && oldestWaitMs >= OLDEST_WAIT_WARNING_MS) {
    return withNote({
      kind: "backlog_drain",
      queue: queueName,
      checkEveryMinutes: 5,
      maxHours: 1,
    });
  }

  return queueAgeWatchRecommendation(queueName);
}

function queueAgeWatchRecommendation(
  queueName: string,
  thresholdMinutes: number = WATCH_DEFAULT_QUEUE_AGE_MINUTES
): WatchSpec {
  return withNote({
    kind: "queue_oldest_age",
    queue: queueName,
    thresholdMinutes,
    checkEveryMinutes: 5,
    maxHours: 1,
  });
}

export function errorWatchRecommendation(errorFriendlyId: string): WatchSpec {
  return withNote({
    kind: "error_recurrence",
    fingerprint: errorFriendlyId,
    checkEveryMinutes: 5,
    maxHours: 6,
  });
}

/** Only offered on a degraded report. `fromSeverity` is what the recovery is measured from. */
export function healthWatchRecommendation(fromSeverity: "warn" | "crit"): WatchSpec {
  return withNote({
    kind: "health_recovery",
    report: "health",
    fromSeverity,
    checkEveryMinutes: 5,
    maxHours: 2,
  });
}
