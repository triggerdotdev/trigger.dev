import {
  getWatch,
  listExpiredActiveWatches,
  markWatchDelivered,
  transitionWatchCondition,
  type Watch,
} from "@internal/dashboard-agent-db";
import { logger, schedules } from "@trigger.dev/sdk";

import {
  appendWakeToSession,
  expiredFacts,
  getWatchDb,
  resolveAndDeliver,
  type WatchDeliveryDeps,
} from "./watch-tick";

/**
 * The expiry backstop. A watch normally ends on its own last tick — the row is the
 * authority on expiry, so the tick past `expiresAt` runs the final check and
 * resolves. But that depends on the tick chain still being alive: a lost trigger,
 * a run that exhausted its retries, or a watch whose token can no longer reach the
 * check endpoint all leave an `active` row past its deadline, holding one of the
 * chat's three watch slots and joining dedup forever.
 *
 * This sweep makes expiry deterministic instead: on a fixed cadence it expires
 * every overdue active row and wakes its chat through the SAME path the tick uses
 * (`resolveAndDeliver`: atomic transition → session append → `markWatchDelivered`),
 * so a swept watch is indistinguishable from one the tick expired.
 *
 * It races the tick harmlessly: the transition is guarded on `active`, so exactly
 * one of them wins and the loser delivers the winner's outcome only if it's still
 * owed.
 */

/** Shortest check cadence is a minute; every 5 bounds the overrun cheaply. */
const SWEEP_CRON = "*/5 * * * *";

/** Per-run cap. Overdue rows are swept oldest first, so the rest land next run. */
const SWEEP_BATCH_LIMIT = 100;

export type WatchSweepDeps = WatchDeliveryDeps & {
  listExpired: (params: { now: Date; limit: number }) => Promise<Watch[]>;
  now?: () => Date;
  limit?: number;
};

export type WatchSweepResult = {
  scanned: number;
  expired: number;
  /** Someone else resolved the row first; this run only completed the delivery. */
  deliveredOnly: number;
  /** Already terminal and already delivered: nothing to do. */
  skipped: number;
  failed: number;
};

/**
 * One sweep. Each row is handled independently: a failing append must not stop the
 * rest of the batch, so failures are counted and the run throws at the end — the
 * row itself is left terminal with the delivery still `pending`, which is the same
 * state a crashed tick leaves and is recovered the same way (any later invocation
 * on that watch delivers only).
 */
export async function sweepExpiredWatches(deps: WatchSweepDeps): Promise<WatchSweepResult> {
  const now = deps.now?.() ?? new Date();
  const overdue = await deps.listExpired({ now, limit: deps.limit ?? SWEEP_BATCH_LIMIT });

  const result: WatchSweepResult = {
    scanned: overdue.length,
    expired: 0,
    deliveredOnly: 0,
    skipped: 0,
    failed: 0,
  };

  for (const watch of overdue) {
    try {
      // Unverified on purpose: the sweep never runs a check, so the narration must
      // not claim the condition didn't happen — same facts as a tick whose final
      // check couldn't run.
      const { outcome } = await resolveAndDeliver(
        deps,
        watch,
        "expired",
        expiredFacts(watch, { verified: false, reason: "unverified_at_expiry" })
      );

      if (outcome === "expired") result.expired++;
      else if (outcome === "delivered_only") result.deliveredOnly++;
      else result.skipped++;
    } catch (error) {
      result.failed++;
      logger.error("dashboard-agent watch expiry sweep failed for a watch", {
        watchId: watch.id,
        error: (error as Error).message,
      });
    }
  }

  if (result.failed > 0) {
    throw new Error(`the expiry sweep failed on ${result.failed} of ${result.scanned} watches`);
  }

  return result;
}

export const watchExpirySweep = schedules.task({
  id: "dashboard-agent-watch-expiry-sweep",
  cron: SWEEP_CRON,
  // Everything the sweep does is guarded or idempotent, so a retry re-sweeps
  // safely: the rows it already resolved are no longer active.
  retry: { maxAttempts: 3 },
  run: async (): Promise<WatchSweepResult> => {
    const { db } = getWatchDb();
    const result = await sweepExpiredWatches({
      store: {
        getWatch: (params) => getWatch(db, params),
        transitionWatchCondition: (params) => transitionWatchCondition(db, params),
        markWatchDelivered: (params) => markWatchDelivered(db, params),
      },
      listExpired: (params) => listExpiredActiveWatches(db, params),
      deliver: appendWakeToSession,
      // An expiry never alerts — only a fired watch does — so this is unreachable
      // here; it exists because the delivery path is shared with the tick.
      notifyFired: async () => {},
    });

    logger.info("dashboard-agent watch expiry sweep", result);

    return result;
  },
});
