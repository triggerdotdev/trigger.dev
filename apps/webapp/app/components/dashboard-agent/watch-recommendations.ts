/**
 * The condition each object recommends when its Watch action opens: a run when it
 * finishes, a queue on the wait SLA (or the drain, when the wait is already past
 * it), an error if it happens again, a degraded health report when it recovers.
 *
 * These defaults are product decisions and carry real identifiers, so they live in
 * one testable place rather than in the routes or the button. Every other variant
 * is one tap deeper under Customize.
 */
import {
  WATCH_DEFAULT_QUEUE_AGE_MINUTES,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";
import { OLDEST_WAIT_WARNING_MS } from "~/components/queues/queue-thresholds";

/**
 * A run is the one object worth checking every minute: it is a single row read, and
 * a run that lands in ninety seconds should not be reported five minutes late.
 */
export function runWatchRecommendation(runFriendlyId: string): WatchSpec {
  return {
    kind: "run_finished",
    runId: runFriendlyId,
    checkEveryMinutes: 1,
    maxHours: 1,
    note: `tell me when run ${runFriendlyId} finishes`,
  };
}

/**
 * A backlog is an aggregate, so the cadence starts at the 5-minute floor.
 *
 * The recommendation must be a future condition: a watch whose condition is already
 * true one-shots with "that already happened". A queue already waiting past the
 * warning threshold gets the recovery ("when it drains"); a queue not late yet gets
 * the SLA, since its drain may already be true. `oldestWaitMs` is threaded from the
 * page; without it the recommendation is the SLA.
 */
export function queueWatchRecommendation(
  queueName: string,
  context?: { oldestWaitMs?: number | null }
): WatchSpec {
  const oldestWaitMs = context?.oldestWaitMs ?? null;
  if (oldestWaitMs !== null && oldestWaitMs >= OLDEST_WAIT_WARNING_MS) {
    return {
      kind: "backlog_drain",
      queue: queueName,
      checkEveryMinutes: 5,
      maxHours: 1,
      note: `tell me when the ${queueName} queue drains`,
    };
  }

  return queueAgeWatchRecommendation(queueName);
}

/** The wait SLA the queue page already calls late. */
export function queueAgeWatchRecommendation(
  queueName: string,
  thresholdMinutes: number = WATCH_DEFAULT_QUEUE_AGE_MINUTES
): WatchSpec {
  return {
    kind: "queue_oldest_age",
    queue: queueName,
    thresholdMinutes,
    checkEveryMinutes: 5,
    maxHours: 1,
    note: `tell me if runs in ${queueName} wait longer than ${thresholdMinutes} minutes`,
  };
}

/**
 * A recurrence needs room to happen, so the window is longer than the other three:
 * plenty of errors come back within the working day rather than in ten minutes.
 */
export function errorWatchRecommendation(errorFriendlyId: string): WatchSpec {
  return {
    kind: "error_recurrence",
    fingerprint: errorFriendlyId,
    checkEveryMinutes: 5,
    maxHours: 6,
    note: `ping me if error ${errorFriendlyId} happens again`,
  };
}

/**
 * Only offered on a degraded report: a recovery watch is meaningless while
 * everything is fine. `fromSeverity` is the state the recovery is measured from.
 */
export function healthWatchRecommendation(fromSeverity: "warn" | "crit"): WatchSpec {
  return {
    kind: "health_recovery",
    report: "health",
    fromSeverity,
    checkEveryMinutes: 5,
    maxHours: 2,
    note: "tell me when health is back to normal",
  };
}
