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
 * The two halves have different dependencies, and that split is load-bearing:
 * finalizing a watch needs nothing but the database and the authorization checks,
 * while handing a wake over needs a configured agent project to hand it to. So the
 * finalization ALWAYS runs — a configuration that disappeared after the watches
 * were created (a rotated secret, a rollback) must not freeze every row as `active`
 * forever, holding the chat's watch slots. What can't be handed over is simply left
 * owed, and the delivery half picks it up when the configuration returns.
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
 * `active`, the wake is claimed atomically before it is appended, and the action id
 * is stable — so the sweep racing a live tick resolves to exactly one winner, and a
 * re-run is a no-op.
 */

import {
  cancelWatch,
  deleteTerminalWatchesOlderThan,
  listExpiredActiveWatches,
  listWatchesAwaitingDelivery,
  transitionWatchCondition,
  type Watch,
} from "@internal/dashboard-agent-db";
import {
  watchResolutionForCheck,
  watchResolutionToWireStatus,
  type WatchObservedOutcome,
  type WatchResolution,
} from "@internal/dashboard-agent-contracts";
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

/**
 * How long a terminal watch is kept. A resolved watch is read by nothing once its
 * wake has landed — the outcome lives in the chat transcript from then on — so a
 * week is well past the point where anyone revisits the row, and still leaves any
 * post-incident look at "what did the watch actually see" plenty of room.
 */
export const WATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-run cap for the retention delete, higher than the other two: it is one
 * statement rather than a row-at-a-time loop, and a backlog should drain in a few
 * runs rather than a few days.
 */
const RETENTION_BATCH_LIMIT = 500;

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
  /**
   * Outcomes that were decided but couldn't be handed over, because the agent
   * project isn't configured. They stay owed for the next sweep.
   */
  deliveryDeferred: number;
  /** Long-terminal rows dropped by retention. */
  purged: number;
  failed: number;
};

export type WatchSweepDeps = {
  now?: () => Date;
  limit?: number;
  /** Overdue `active` rows. */
  listOverdue?: (params: { now: Date; limit: number }) => Promise<Watch[]>;
  /** Resolved rows whose wake is still owed. */
  listAwaitingDelivery?: (params: { olderThan: Date; limit: number }) => Promise<Watch[]>;
  /** Re-authorization of the watch's initiating user. */
  authorize?: (watch: Watch) => Promise<WatchAuthorization>;
  /** The environment readers the final check runs against. */
  checkDeps?: (environment: AuthenticatedEnvironment, now: Date) => WatchCheckDeps;
  /** Hand the wake back to the watcher task. Must throw if it can't be scheduled. */
  deliver?: (watch: Watch) => Promise<void>;
  /**
   * Whether there is an agent project to hand wakes to. Gates the delivery half
   * only — finalization never depends on it.
   */
  configured?: () => boolean;
  /** Drop terminal rows older than `before`. Returns how many went. */
  purgeTerminal?: (params: { before: Date; limit: number }) => Promise<number>;
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

/**
 * How a FINAL check's verdict resolves the row — the window boundary of §7.4.
 *
 * The last evaluation is a real evaluation: a successful final read may still
 * resolve `condition_met` or `condition_impossible`, and only a `pending` or
 * `unavailable` result becomes `window_completed`. `watchResolutionForCheck`
 * owns that rule; this function only dresses it in the facts the surfaces read.
 */
function resolutionFor(
  watch: Watch,
  outcome: WatchCheckOutcome
): {
  resolution: WatchResolution;
  observed: WatchObservedOutcome;
  facts: Record<string, unknown>;
} {
  // Always non-null here: this is the boundary evaluation.
  const resolution = watchResolutionForCheck(outcome.result, true)!;

  switch (outcome.result) {
    case "satisfied":
      return {
        resolution,
        observed: outcome.observed,
        facts: { verified: true, ...outcome.facts },
      };
    case "terminal_unsatisfied":
      return {
        resolution,
        observed: outcome.observed,
        facts: expiredFacts(watch, {
          verified: true,
          reason: "terminal_unsatisfied",
          facts: outcome.facts,
        }),
      };
    case "pending":
      return {
        resolution,
        observed: outcome.observed,
        facts: expiredFacts(watch, {
          verified: true,
          reason: "not_met_by_expiry",
          facts: outcome.facts,
        }),
      };
    default:
      // The check couldn't run. The deadline still passed, so the window
      // completes — but unverified, never as "it didn't happen". The observation
      // carries `verified: false`, which is what makes the presentation say the
      // condition couldn't be confirmed.
      return {
        resolution,
        observed: outcome.observed,
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
 *
 * `canDeliver: false` stops at the resolution: the row is terminal with its wake
 * owed, which is exactly the state the delivery half recovers.
 */
export async function finalizeOverdueWatch(
  watch: Watch,
  deps: WatchSweepDeps & { canDeliver?: boolean } = {}
): Promise<WatchFinalizeOutcome> {
  const now = deps.now?.() ?? new Date();
  const authorize = deps.authorize ?? defaultAuthorize;
  const buildCheckDeps = deps.checkDeps ?? watchCheckDeps;
  const deliver = deps.deliver ?? scheduleWatchDelivery;
  const canDeliver = deps.canDeliver ?? true;

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

  const resolved = resolutionFor(watch, outcome);
  const transitioned = await transitionWatchCondition(dashboardAgentDb, {
    id: watch.id,
    resolution: resolved.resolution,
    observedOutcome: resolved.observed,
    lastResult: resolved.facts,
  });

  // Guarded on `active`: a tick resolved it between the list and here, and that
  // outcome (with its own delivery) stands.
  if (!transitioned) return "already_resolved";

  if (resolved.resolution === "condition_met") {
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
  // terminal with its delivery owed — recovered by the delivery half of the next
  // sweep, same as when there is no agent project to hand it to at all.
  if (canDeliver) await deliver(transitioned);
  return watchResolutionToWireStatus(resolved.resolution);
}

/**
 * Recover ONE owed wake: hand it to the watcher task, whatever left it owed — a
 * delivery that failed, a deliverer that died mid-append, or an outcome that was
 * resolved inline by the turn that created the watch.
 *
 * Unconditional on purpose. This sweep cannot tell whether the user was already
 * told: every proof available here (the chat's last message time above all) is
 * moved by a question, an error turn, or another watch's wake, so acting on it
 * loses outcomes. Whether the wake needs prose is decided where the transcript can
 * actually be read — the agent's wake narration skips it when the turn that created
 * the watch already answered inline, and the delivery is marked either way.
 */
export async function recoverWatchDelivery(watch: Watch, deps: WatchSweepDeps = {}): Promise<void> {
  const deliver = deps.deliver ?? scheduleWatchDelivery;
  await deliver(watch);
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
  const purgeTerminal =
    deps.purgeTerminal ?? ((params) => deleteTerminalWatchesOlderThan(dashboardAgentDb, params));

  const result: WatchSweepResult = {
    overdue: 0,
    fired: 0,
    expired: 0,
    cancelled: 0,
    alreadyResolved: 0,
    undelivered: 0,
    redelivered: 0,
    deliveryDeferred: 0,
    purged: 0,
    failed: 0,
  };

  // Whether there is an agent project to hand a wake to. It gates the hand-off
  // only: the rows themselves still have to be finalized, or a configuration that
  // vanished after the watches were created would leave every one of them active
  // and holding a slot forever.
  const canDeliver = configured();
  if (!canDeliver) {
    logger.warn(
      "Dashboard agent watch sweep: the agent isn't configured, so wakes can't be delivered — finalizing only"
    );
  }

  const overdue = await listOverdue({
    now: new Date(now.getTime() - WATCH_EXPIRY_GRACE_MS),
    limit,
  });
  result.overdue = overdue.length;

  for (const watch of overdue) {
    try {
      const outcome = await finalizeOverdueWatch(watch, { ...deps, now: () => now, canDeliver });
      if (outcome === "fired") result.fired++;
      else if (outcome === "expired") result.expired++;
      else if (outcome === "cancelled") result.cancelled++;
      else result.alreadyResolved++;
      // Resolved, but nothing carried the wake away: it stays owed.
      if (!canDeliver && (outcome === "fired" || outcome === "expired")) {
        result.deliveryDeferred++;
      }
    } catch (error) {
      result.failed++;
      logger.error("Dashboard agent watch sweep: failed to finalize a watch", {
        watchId: watch.id,
        error,
      });
    }
  }

  // The delivery half. Skipped wholesale without an agent project — the rows keep
  // their owed wake and the next configured sweep recovers them.
  if (canDeliver) {
    const owed = await listAwaitingDelivery({
      olderThan: new Date(now.getTime() - WATCH_DELIVERY_GRACE_MS),
      limit,
    });
    result.undelivered = owed.length;

    for (const watch of owed) {
      try {
        await recoverWatchDelivery(watch, deps);
        result.redelivered++;
      } catch (error) {
        result.failed++;
        logger.error("Dashboard agent watch sweep: failed to recover a wake", {
          watchId: watch.id,
          error,
        });
      }
    }
  }

  // Retention, last: it only touches rows both halves above are finished with, and
  // it runs whether or not the agent is configured — an unconfigured deployment
  // still shouldn't accumulate week-old rows. Its own try/catch, because losing a
  // retention pass is the cheapest failure here and must not mask the others.
  try {
    result.purged = await purgeTerminal({
      before: new Date(now.getTime() - WATCH_RETENTION_MS),
      limit: RETENTION_BATCH_LIMIT,
    });
  } catch (error) {
    result.failed++;
    logger.error("Dashboard agent watch sweep: failed to purge terminal watches", { error });
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
