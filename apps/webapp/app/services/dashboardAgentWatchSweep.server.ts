/**
 * The watch backstop — expiry and lost deliveries, both driven from here.
 *
 * A watch normally ends on its own last tick: the watcher task runs the final
 * check through the private check endpoint and resolves. That depends on the tick
 * chain still being alive, and it isn't always — a lost trigger, a run that
 * exhausted its retries, a session append that kept failing. Two things are then
 * left behind, and both are this sweep's job:
 *
 *  - an `active` row past its deadline, holding one of the chat's three watch
 *    slots and joining dedup forever, and
 *  - a resolved row whose wake never reached the chat (`deliveryStatus = pending`),
 *    i.e. an outcome the user was promised and never got.
 *
 * It runs in the WEBAPP, not in the agent project, because finalizing a watch is
 * an authorization decision: the initiating user is re-authorized against the
 * watch's immutable project/environment, a user who lost access gets the watch
 * CANCELLED (never woken), and only an authorized watch gets its last check. The
 * agent project has none of that — it reads everything through the check endpoint
 * with a watch token it cannot mint. So the outcome is decided here and the one
 * thing the webapp can't do, appending to a chat's `in` stream, is handed back to
 * the watcher task as a delivery-only invocation.
 *
 * Everything is guarded rather than coordinated: the transition is conditional on
 * `active`, the delivery mark on `pending`, and the wake's action id is stable, so
 * the sweep racing a live tick resolves to exactly one winner and a re-run is a
 * no-op.
 */

import {
  cancelWatch,
  listExpiredActiveWatches,
  listWatchesAwaitingDelivery,
  markWatchDelivered,
  transitionWatchCondition,
  type Watch,
  type WatchAwaitingDelivery,
} from "@internal/dashboard-agent-db";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { enqueueWatchFiredAlert } from "~/services/dashboardAgentWatchAlerts.server";
import {
  checkWatch,
  type WatchCheckDeps,
  type WatchCheckOutcome,
} from "~/services/dashboardAgentWatchChecks";
import { watchCheckDeps } from "~/services/dashboardAgentWatchChecks.server";
import { isDashboardAgentConfigured } from "~/services/dashboardAgent.server";
import {
  authorizeWatchEnvironment,
  scheduleWatchDelivery,
  type WatchAuthorization,
} from "~/services/dashboardAgentWatches.server";
import { logger } from "~/services/logger.server";

/**
 * How long past `expiresAt` a watch is left to the tick chain before the sweep
 * finalizes it. The chain's own final check happens within a cadence of the
 * deadline, so this only has to cover a late tick, not a whole check interval.
 */
export const WATCH_EXPIRY_GRACE_MS = 2 * 60 * 1000;

/**
 * How long a resolved watch may owe its wake before the sweep recovers it. The
 * normal delivery is seconds; this window keeps the recovery from racing a
 * delivery that is still in flight (or being retried by the platform).
 */
export const WATCH_DELIVERY_GRACE_MS = 5 * 60 * 1000;

/** Per-run cap for each half of the sweep. Oldest first, so the rest land next run. */
const SWEEP_BATCH_LIMIT = 100;

/** What one finalization did. */
export type WatchFinalizeOutcome =
  | "fired"
  | "expired"
  /** The user lost access: cancelled, and deliberately not narrated. */
  | "cancelled"
  /** A tick (or another sweep) resolved it first. */
  | "already_resolved";

export type WatchSweepResult = {
  /** Overdue active rows seen. */
  overdue: number;
  fired: number;
  expired: number;
  cancelled: number;
  alreadyResolved: number;
  /** Resolved rows whose wake was still owed. */
  undelivered: number;
  /** Wakes handed back to the watcher task. */
  redelivered: number;
  /** Inline outcomes the turn had already narrated: marked, not re-narrated. */
  narrated: number;
  failed: number;
};

export type WatchSweepDeps = {
  now?: () => Date;
  limit?: number;
  /** Overdue `active` rows. */
  listOverdue?: (params: { now: Date; limit: number }) => Promise<Watch[]>;
  /** Resolved rows whose wake is still owed. */
  listAwaitingDelivery?: (params: {
    olderThan: Date;
    limit: number;
  }) => Promise<WatchAwaitingDelivery[]>;
  /** Re-authorization of the watch's initiating user. */
  authorize?: (watch: Watch) => Promise<WatchAuthorization>;
  /** The environment readers the final check runs against. */
  checkDeps?: (environment: AuthenticatedEnvironment, now: Date) => WatchCheckDeps;
  /** Hand the wake back to the watcher task. Must throw if it can't be scheduled. */
  deliver?: (watch: Watch) => Promise<void>;
  /** Skips the whole sweep when the agent isn't set up on this installation. */
  configured?: () => boolean;
};

/**
 * Facts for a swept expiry, in the same shape the tick writes (the wake narration
 * reads these keys either way).
 *
 * `verified: false` means the condition itself couldn't be evaluated, so the
 * narration must not claim the thing didn't happen — it carries the last
 * observation we do have instead.
 */
function expiredFacts(
  watch: Watch,
  args: { verified: boolean; reason: string; facts?: Record<string, unknown> }
): Record<string, unknown> {
  return {
    verified: args.verified,
    reason: args.reason,
    expiredAt: watch.expiresAt.toISOString(),
    checks: watch.tickCount,
    ...(args.verified
      ? (args.facts ?? {})
      : {
          lastObservedAt: watch.lastCheckedAt?.toISOString(),
          lastObservation: watch.lastResult,
        }),
  };
}

/** How a final check's verdict resolves the row. */
function resolutionFor(
  watch: Watch,
  outcome: WatchCheckOutcome
): { status: "fired" | "expired"; facts: Record<string, unknown> } {
  switch (outcome.result) {
    case "satisfied":
      return { status: "fired", facts: { verified: true, ...outcome.facts } };
    case "terminal_unsatisfied":
      return {
        status: "expired",
        facts: expiredFacts(watch, {
          verified: true,
          reason: "terminal_unsatisfied",
          facts: outcome.facts,
        }),
      };
    case "pending":
      return {
        status: "expired",
        facts: expiredFacts(watch, {
          verified: true,
          reason: "not_met_by_expiry",
          facts: outcome.facts,
        }),
      };
    default:
      // The check couldn't run. The deadline still passed, so the watch expires —
      // but as unverified, never as "it didn't happen".
      return {
        status: "expired",
        facts: expiredFacts(watch, { verified: false, reason: "unverified_at_expiry" }),
      };
  }
}

/**
 * Finalize ONE overdue watch: re-authorize, run the last check, resolve, and hand
 * the wake to the watcher task.
 *
 * The order is the point. Re-authorization comes first and a revoked user ends the
 * watch as `cancelled` with no wake at all — a watch must never outlive the access
 * it was created with, and a cancellation is never narrated. Only then does the
 * final check read anything, so the watch gets the same last look a tick past the
 * deadline would have given it.
 */
export async function finalizeOverdueWatch(
  watch: Watch,
  deps: WatchSweepDeps = {}
): Promise<WatchFinalizeOutcome> {
  const now = deps.now?.() ?? new Date();
  const authorize = deps.authorize ?? defaultAuthorize;
  const buildCheckDeps = deps.checkDeps ?? watchCheckDeps;
  const deliver = deps.deliver ?? scheduleWatchDelivery;

  const authorization = await authorize(watch);
  if (!authorization.ok) {
    await cancelWatch(dashboardAgentDb, { id: watch.id, reason: "access_revoked" });
    logger.info("Dashboard agent watch sweep: cancelled a watch whose access was revoked", {
      watchId: watch.id,
    });
    return "cancelled";
  }

  const since = watch.spec.since ? new Date(watch.spec.since) : watch.createdAt;
  const outcome = await checkWatch(
    watch.spec,
    buildCheckDeps(authorization.environment, now),
    { now, since },
    (error) =>
      logger.error("Dashboard agent watch sweep: the final check failed", {
        watchId: watch.id,
        error,
      })
  );

  const resolution = resolutionFor(watch, outcome);
  const transitioned = await transitionWatchCondition(dashboardAgentDb, {
    id: watch.id,
    status: resolution.status,
    lastResult: resolution.facts,
  });

  // Guarded on `active`: a tick resolved it between the list and here, and that
  // outcome (with its own delivery) stands.
  if (!transitioned) return "already_resolved";

  if (resolution.status === "fired") {
    // The configured alert channels. Keyed on the watch, so the wake's own
    // notification can't double-alert it.
    try {
      await enqueueWatchFiredAlert(transitioned, "fired");
    } catch (error) {
      logger.error("Dashboard agent watch sweep: failed to enqueue the fired alert", {
        watchId: watch.id,
        error,
      });
    }
  }

  // The wake itself. Throws if it can't be scheduled, which leaves the row
  // terminal + pending — recovered by the delivery half of the next sweep.
  await deliver(transitioned);
  return resolution.status;
}

/**
 * Recover ONE owed wake.
 *
 * Two kinds of row land here. Most are a delivery that failed: the wake is simply
 * handed to the watcher task again (the action id is stable, so a wake that did
 * land is not narrated twice). The other kind is an outcome that was resolved
 * INLINE — a watch that was already true when it was created, narrated by the turn
 * that created it — and for those the delivery is only marked once that turn's
 * persistence proves the narration exists. A message persisted after the watch
 * resolved is that proof; without one the turn died before saying anything, so the
 * wake is delivered like any other.
 */
export async function recoverWatchDelivery(
  row: WatchAwaitingDelivery,
  deps: WatchSweepDeps = {}
): Promise<"narrated" | "redelivered"> {
  const deliver = deps.deliver ?? scheduleWatchDelivery;
  const { watch, chatLastMessageAt } = row;

  const resolvedAt = watch.firedAt ?? watch.lastCheckedAt;
  const narratedInline =
    (watch.lastResult as { narratedInline?: unknown } | null)?.narratedInline === true;

  if (
    narratedInline &&
    resolvedAt &&
    chatLastMessageAt &&
    chatLastMessageAt.getTime() >= resolvedAt.getTime()
  ) {
    await markWatchDelivered(dashboardAgentDb, { id: watch.id });
    return "narrated";
  }

  await deliver(watch);
  return "redelivered";
}

/**
 * One sweep: finalize what is overdue, then recover what was never delivered.
 *
 * Each row is handled on its own — a single failure must not cost the rest of the
 * batch — and the run throws at the end if anything failed, so the job is retried
 * and the failures are visible. A row left half-done is left in a state the next
 * sweep recovers: terminal with the delivery still owed.
 */
export async function sweepDashboardAgentWatches(
  deps: WatchSweepDeps = {}
): Promise<WatchSweepResult> {
  const now = deps.now?.() ?? new Date();
  const limit = deps.limit ?? SWEEP_BATCH_LIMIT;
  const configured = deps.configured ?? isDashboardAgentConfigured;
  const listOverdue =
    deps.listOverdue ?? ((params) => listExpiredActiveWatches(dashboardAgentDb, params));
  const listAwaitingDelivery =
    deps.listAwaitingDelivery ??
    ((params) => listWatchesAwaitingDelivery(dashboardAgentDb, params));

  const result: WatchSweepResult = {
    overdue: 0,
    fired: 0,
    expired: 0,
    cancelled: 0,
    alreadyResolved: 0,
    undelivered: 0,
    redelivered: 0,
    narrated: 0,
    failed: 0,
  };

  // No agent on this installation means no watches, and no way to deliver a wake
  // even if there were — don't touch the store at all.
  if (!configured()) return result;

  const overdue = await listOverdue({
    now: new Date(now.getTime() - WATCH_EXPIRY_GRACE_MS),
    limit,
  });
  result.overdue = overdue.length;

  for (const watch of overdue) {
    try {
      const outcome = await finalizeOverdueWatch(watch, { ...deps, now: () => now });
      if (outcome === "fired") result.fired++;
      else if (outcome === "expired") result.expired++;
      else if (outcome === "cancelled") result.cancelled++;
      else result.alreadyResolved++;
    } catch (error) {
      result.failed++;
      logger.error("Dashboard agent watch sweep: failed to finalize a watch", {
        watchId: watch.id,
        error,
      });
    }
  }

  const owed = await listAwaitingDelivery({
    olderThan: new Date(now.getTime() - WATCH_DELIVERY_GRACE_MS),
    limit,
  });
  result.undelivered = owed.length;

  for (const row of owed) {
    try {
      const outcome = await recoverWatchDelivery(row, deps);
      if (outcome === "narrated") result.narrated++;
      else result.redelivered++;
    } catch (error) {
      result.failed++;
      logger.error("Dashboard agent watch sweep: failed to recover a wake", {
        watchId: row.watch.id,
        error,
      });
    }
  }

  if (result.failed > 0) {
    throw new Error(`The dashboard agent watch sweep failed on ${result.failed} watches`);
  }

  return result;
}

function defaultAuthorize(watch: Watch): Promise<WatchAuthorization> {
  return authorizeWatchEnvironment({
    userId: watch.userId,
    organizationId: watch.organizationId,
    projectId: watch.projectId,
    environmentId: watch.environmentId,
  });
}
