/**
 * The condition each object recommends when its **Watch…** action opens (§2.1).
 *
 * Kept out of the routes and out of the button, exactly like `investigate-prompts.ts`:
 * these defaults are product decisions (which condition, how long, how often), and
 * they carry real identifiers, so they belong in one testable place.
 *
 * | Object | Recommendation |
 * |---|---|
 * | Run | when it finishes |
 * | Queue | when it drains |
 * | Error | if it happens again |
 * | Health (degraded) | when it recovers |
 *
 * Every other variant is one tap deeper, under **Customize** — nothing here is a
 * menu of options.
 */
import type { WatchSpec } from "@internal/dashboard-agent-contracts";

/**
 * A run is the one object worth checking every minute: it is a single row read,
 * and a run that lands in ninety seconds should not be reported five minutes late.
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

/** A backlog is an aggregate, so the cadence starts at the 5-minute floor (§7.1). */
export function queueWatchRecommendation(queueName: string): WatchSpec {
  return {
    kind: "backlog_drain",
    queue: queueName,
    checkEveryMinutes: 5,
    maxHours: 1,
    note: `tell me when the ${queueName} queue drains`,
  };
}

/**
 * A recurrence needs room to happen: an error that comes back in ten minutes was
 * never really fixed, but plenty come back within the working day — hence the
 * longer window than the other three.
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
 * Only offered on a DEGRADED report: "watch for a recovery" is meaningless while
 * everything is fine, and `fromSeverity` is the state the recovery is measured
 * from.
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
