/**
 * The watch backstop for a dead tick chain. Finalization runs even with no agent project, or rows
 * would stay `active` forever; what can't be handed over stays owed. Guarded, so a re-run no-ops.
 */

import {
  cancelWatch,
  deleteTerminalWatchesOlderThan,
  deleteWatchSubmissionsOlderThan,
  listExpiredActiveWatches,
  listWatchBatchGroupsToArm,
  listWatchesAwaitingDelivery,
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
  type WatchCheckDeps,
  type WatchCheckOutcome,
} from "~/services/dashboardAgentWatchChecks";
import { watchCheckDeps } from "~/services/dashboardAgentWatchChecks.server";
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

/** How long a terminal watch is kept. Its outcome also lives in the chat transcript. */
export const WATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Higher than the other caps: retention is one statement, not a row-at-a-time loop. */
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
  /** Decided but not handed over, with no agent project. They stay owed. */
  deliveryDeferred: number;
  /** Long-terminal rows dropped by retention. */
  purged: number;
  /** Ledger rows dropped by retention. */
  purgedSubmissions: number;
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
  /** Drop terminal rows older than `before`. Returns how many went. */
  purgeTerminal?: (params: { before: Date; limit: number }) => Promise<number>;
  /** Drop submission-ledger rows older than `before`. */
  purgeSubmissions?: (params: { before: Date; limit: number }) => Promise<number>;
};

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

  // Guarded on `active`: a tick that resolved it first keeps its outcome and delivery.
  if (!transitioned) return "already_resolved";

  if (resolved.resolution === "condition_met") {
    // Keyed on the watch, so the wake's own notification can't double-alert it.
    try {
      await enqueueWatchFiredAlert(transitioned, "fired");
    } catch (error) {
      logger.error("Dashboard agent watch sweep: failed to enqueue the fired alert", {
        watchId: watch.id,
        error,
      });
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
export async function recoverWatchDelivery(watch: Watch, deps: WatchSweepDeps = {}): Promise<void> {
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
  const purgeTerminal =
    deps.purgeTerminal ?? ((params) => deleteTerminalWatchesOlderThan(dashboardAgentDb, params));
  const purgeSubmissions =
    deps.purgeSubmissions ??
    ((params) => deleteWatchSubmissionsOlderThan(dashboardAgentDb, params));

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
    purgedSubmissions: 0,
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

  // Skipped without an agent project: the rows keep their owed wake for the next sweep.
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

  // Retention runs last, over rows both halves are finished with. Its own try/catch so a
  // lost retention pass can't mask the other failures.
  try {
    const before = new Date(now.getTime() - WATCH_RETENTION_MS);
    result.purged = await purgeTerminal({ before, limit: RETENTION_BATCH_LIMIT });
    // The ledger's rows age out on the same window: past it no client is still retrying.
    result.purgedSubmissions = await purgeSubmissions({ before, limit: RETENTION_BATCH_LIMIT });
  } catch (error) {
    result.failed++;
    logger.error("Dashboard agent watch sweep: failed to purge terminal watches", { error });
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
