/**
 * The watch backstop for a dead tick chain. Finalization runs even with no agent project, or rows
 * would stay `active` forever; what can't be handed over stays owed. Guarded, so a re-run no-ops.
 */

import {
  cancelWatch,
  claimWatchAlertDispatch,
  listExpiredActiveWatches,
  listWatchBatchGroupsToArm,
  listWatchesAwaitingDelivery,
  releaseWatchAlertDispatch,
  transitionWatchCondition,
  type Watch,
  type WatchBatchGroup,
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
  previousCheckFacts,
  type WatchCheckDeps,
  type WatchCheckOutcome,
} from "~/services/dashboardAgentWatchChecks";
import { watchCheckDeps } from "~/services/dashboardAgentWatchChecks.server";
import { mapWithConcurrency, shareReads } from "~/services/dashboardAgentWatchBatch.server";
import { isDashboardAgentConfigured } from "~/services/dashboardAgent.server";
import {
  armDashboardAgentWatchBatch,
  authorizeWatchEnvironment,
  scheduleWatchDelivery,
  type WatchAuthorization,
} from "~/services/dashboardAgentWatches.server";
import { logger } from "~/services/logger.server";

/**
 * How long past `expiresAt` a watch is left to the tick chain. Only has to cover a late
 * tick: the chain's own final check happens within a cadence of the deadline.
 */
export const WATCH_EXPIRY_GRACE_MS = 2 * 60 * 1000;

/**
 * How long a resolved watch may owe its wake before the sweep recovers it. Long enough that
 * the recovery can't race a delivery still in flight.
 */
export const WATCH_DELIVERY_GRACE_MS = 5 * 60 * 1000;

/** Per-run cap for each half of the sweep. Oldest first, so the rest land next run. */
const SWEEP_BATCH_LIMIT = 100;

/**
 * How many rows one sweep handles at once. An incident expires a whole group together, and a
 * bound is what stops one slow tenant spending the entire visibility window.
 */
const SWEEP_CONCURRENCY = 8;

/** What one finalization did. */
type WatchFinalizeOutcome =
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
  /** Decided but not handed over, with no agent project. They stay owed. */
  deliveryDeferred: number;
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
  /** Gates the delivery half only. Finalization never depends on it. */
  configured?: () => boolean;
  /** How many rows are handled at once. */
  concurrency?: number;
};

/**
 * One re-authorization per (user, org, project, environment) for the whole sweep. An incident
 * expires a group together, and every row of it names the same access question.
 */
function authorizeOncePerSweep(
  deps: WatchSweepDeps
): (watch: Watch) => Promise<WatchAuthorization> {
  const authorize = deps.authorize ?? defaultAuthorize;
  const seen = new Map<string, Promise<WatchAuthorization>>();
  return (watch) => {
    const key = `${watch.userId}:${watch.organizationId}:${watch.projectId}:${watch.environmentId}`;
    const cached = seen.get(key);
    if (cached) return cached;
    const pending = authorize(watch);
    seen.set(key, pending);
    return pending;
  };
}

/**
 * One set of readers per environment, read-shared the way the batch's are: `now` is fixed for
 * the sweep, so the same read can't answer two ways.
 */
function readersOncePerSweep(
  deps: WatchSweepDeps
): (environment: AuthenticatedEnvironment, now: Date) => WatchCheckDeps {
  const build = deps.checkDeps ?? watchCheckDeps;
  const seen = new Map<string, WatchCheckDeps>();
  return (environment, now) => {
    const cached = seen.get(environment.id);
    if (cached) return cached;
    const readers = shareReads(build(environment, now));
    seen.set(environment.id, readers);
    return readers;
  };
}

/**
 * Facts for a swept expiry, in the same shape the tick writes. `verified: false` means the
 * condition couldn't be evaluated, and carries the last observation instead.
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
 * How a final check's verdict resolves the row. The final read is a real evaluation, so only
 * `pending` and `unavailable` become `window_completed`. `watchResolutionForCheck` owns that.
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
      // The check couldn't run, so the window completes unverified.
      return {
        resolution,
        observed: outcome.observed,
        facts: expiredFacts(watch, { verified: false, reason: "unverified_at_expiry" }),
      };
  }
}

/**
 * Finalize one overdue watch. Re-authorization comes first, before the final check reads
 * anything; `canDeliver: false` stops at the resolution, leaving the wake owed.
 */
async function finalizeOverdueWatch(
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
    // A stateful condition is a transition across checks, so the boundary evaluation needs
    // the previous facts to see one — and to record what it saw, not a reset.
    { now, since, previous: previousCheckFacts(watch.lastResult) },
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

  // Guarded on `active`: a tick that resolved it first keeps its outcome and delivery.
  if (!transitioned) return "already_resolved";

  if (resolved.resolution === "condition_met") {
    // Claimed first, exactly as the fire callback does: the wake this sweep is about to
    // schedule reports the same fired watch, and an unclaimed row alerts a second time.
    const claimed = await claimWatchAlertDispatch(dashboardAgentDb, {
      id: watch.id,
      terminalStatus: "fired",
    });
    if (claimed) {
      try {
        await enqueueWatchFiredAlert(transitioned, "fired");
      } catch (error) {
        await releaseWatchAlertDispatch(dashboardAgentDb, {
          id: watch.id,
          terminalStatus: "fired",
        });
        logger.error("Dashboard agent watch sweep: failed to enqueue the fired alert", {
          watchId: watch.id,
          error,
        });
      }
    }
  }

  // Throws if it can't be scheduled, leaving the row terminal with its delivery owed.
  if (canDeliver) await deliver(transitioned);
  return watchResolutionToWireStatus(resolved.resolution);
}

/**
 * Recover one owed wake, unconditionally: this sweep can't tell whether the user was already
 * told. Whether the wake needs prose is decided where the transcript can be read.
 */
async function recoverWatchDelivery(watch: Watch, deps: WatchSweepDeps = {}): Promise<void> {
  const deliver = deps.deliver ?? scheduleWatchDelivery;
  await deliver(watch);
}

/**
 * One sweep: finalize what is overdue, then recover what was never delivered. Each row is
 * handled on its own, and the run throws at the end if any failed so the job is retried.
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
    deliveryDeferred: 0,
    failed: 0,
  };

  // Gates the hand-off only: the rows still have to be finalized.
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

  // The authorization and the readers are resolved once for the whole sweep, so a group of
  // expiries costs one of each rather than one per row.
  const perSweep: WatchSweepDeps & { canDeliver: boolean } = {
    ...deps,
    now: () => now,
    canDeliver,
    authorize: authorizeOncePerSweep(deps),
    checkDeps: readersOncePerSweep(deps),
  };

  const finalized = await mapWithConcurrency(
    overdue,
    deps.concurrency ?? SWEEP_CONCURRENCY,
    async (watch) => {
      try {
        return await finalizeOverdueWatch(watch, perSweep);
      } catch (error) {
        logger.error("Dashboard agent watch sweep: failed to finalize a watch", {
          watchId: watch.id,
          error,
        });
        return null;
      }
    }
  );

  for (const outcome of finalized) {
    if (outcome === null) result.failed++;
    else if (outcome === "fired") result.fired++;
    else if (outcome === "expired") result.expired++;
    else if (outcome === "cancelled") result.cancelled++;
    else result.alreadyResolved++;
    // Resolved, but nothing carried the wake away: it stays owed.
    if (!canDeliver && (outcome === "fired" || outcome === "expired")) {
      result.deliveryDeferred++;
    }
  }

  // Skipped without an agent project: the rows keep their owed wake for the next sweep.
  if (canDeliver) {
    const owed = await listAwaitingDelivery({
      olderThan: new Date(now.getTime() - WATCH_DELIVERY_GRACE_MS),
      limit,
    });
    result.undelivered = owed.length;

    const recovered = await mapWithConcurrency(
      owed,
      deps.concurrency ?? SWEEP_CONCURRENCY,
      async (watch) => {
        try {
          await recoverWatchDelivery(watch, deps);
          return true;
        } catch (error) {
          logger.error("Dashboard agent watch sweep: failed to recover a wake", {
            watchId: watch.id,
            error,
          });
          return false;
        }
      }
    );

    for (const ok of recovered) {
      if (ok) result.redelivered++;
      else result.failed++;
    }
  }

  if (result.failed > 0) {
    throw new Error(`The dashboard agent watch sweep failed on ${result.failed} watches`);
  }

  return result;
}

export type WatchBatchRearmResult = {
  /** Groups with active watches and no live chain. */
  stale: number;
  armed: number;
  failed: number;
};

export type WatchBatchRearmDeps = {
  now?: () => Date;
  limit?: number;
  /** Groups whose chain is missing, stopped, or has gone silent. */
  listGroups?: (params: { now: Date; limit: number }) => Promise<WatchBatchGroup[]>;
  /** Start a chain for one group. */
  arm?: (params: {
    environmentId: string;
    cadenceMinutes: number;
    now?: Date;
  }) => Promise<{ running: boolean }>;
  configured?: () => boolean;
};

const REARM_BATCH_LIMIT = 200;

/**
 * Re-arm batch chains that died. `armWatchBatch` re-checks the same timestamp in the statement
 * that arms, so racing a merely slow chain arms nothing and two runs start one chain.
 */
export async function rearmDashboardAgentWatchBatches(
  deps: WatchBatchRearmDeps = {}
): Promise<WatchBatchRearmResult> {
  const now = deps.now?.() ?? new Date();
  const limit = deps.limit ?? REARM_BATCH_LIMIT;
  const configured = deps.configured ?? isDashboardAgentConfigured;
  const listGroups =
    deps.listGroups ?? ((params) => listWatchBatchGroupsToArm(dashboardAgentDb, params));
  const arm = deps.arm ?? armDashboardAgentWatchBatch;

  const result: WatchBatchRearmResult = { stale: 0, armed: 0, failed: 0 };

  // Nothing to trigger a chain into. The expiry half still finalizes the rows.
  if (!configured()) return result;

  const groups = await listGroups({ now, limit });
  result.stale = groups.length;

  for (const group of groups) {
    try {
      const { running } = await arm({ ...group, now });
      if (running) result.armed++;
    } catch (error) {
      result.failed++;
      logger.error("Dashboard agent watch sweep: failed to re-arm a batch chain", {
        ...group,
        error,
      });
    }
  }

  if (result.failed > 0) {
    throw new Error(`The dashboard agent batch re-arm failed on ${result.failed} groups`);
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
