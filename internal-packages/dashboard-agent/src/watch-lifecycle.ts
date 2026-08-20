import {
  isTerminalWatchStatus,
  isWatchDeliveryOwed,
  type Watch,
} from "@internal/dashboard-agent-db";
import {
  watchResolutionForCheck,
  type WatchCheckResult,
  type WatchObservedOutcome,
} from "@internal/dashboard-agent-contracts";
import { logger } from "@trigger.dev/sdk";
import {
  deliverWake,
  expiredFacts,
  firedFacts,
  resolveAndDeliver,
  type WatchDeliveryDeps,
  type WatchTickResult,
  type WatchTickStore,
} from "./watch-delivery";

/**
 * The condition half of a watch: one generation's claim, check and verdict. The webapp
 * evaluates conditions; this decides what the verdict means for the row.
 */

export type WatchLifecycleDeps = WatchDeliveryDeps & {
  store: WatchTickStore;
  /** `final` is decided by the claimed row, never by the implementation. */
  check: (args: { watch: Watch; final: boolean }) => Promise<CheckOutcome>;
  /** Keep this watch's chain alive. A no-op in the batch, which reschedules once. */
  onPending: (watch: Watch, tick: number) => Promise<void>;
};

// `handOff` is orthogonal to the verdict: the group's batch chain now polls this
// watch, so the caller stops keeping its own chain alive.
export type CheckOutcome =
  | {
      kind: "result";
      result: WatchCheckResult;
      facts?: Record<string, unknown>;
      observed?: WatchObservedOutcome;
      handOff?: boolean;
    }
  // The row is already over and the webapp knows it, so the tick exits without
  // transitioning or delivering.
  | { kind: "revoked"; code?: string }
  // The check itself couldn't run. Never true, never false.
  | {
      kind: "unavailable";
      detail?: string;
      observed?: WatchObservedOutcome;
      handOff?: boolean;
    };

// The row is no longer active, so nothing is left to transition or deliver. Any other
// non-2xx is a failed check and the tick keeps watching to the row's own deadline.
export const REVOKED_CODES = new Set(["access_revoked", "cancelled", "not_found"]);

/**
 * The last result the check actually produced. A failure record is unwrapped, so a run of
 * failures replaces one another instead of nesting — the row's `lastResult` reaches the
 * wake facts, the alert and the webhook body.
 */
function lastObservedResult(lastResult: unknown): Record<string, unknown> | undefined {
  let current = lastResult;
  while (isCheckFailure(current)) current = current.previous;
  return current !== null && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : undefined;
}

function isCheckFailure(value: unknown): value is { previous?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { checkFailed?: unknown }).checkFailed === true
  );
}

// One watch's tick, shared by the per-watch task and the batch. The order of the
// branches below is the algorithm.
export async function runWatchLifecycle(
  args: { watchId: string; tick: number; deliverOnly?: boolean },
  deps: WatchLifecycleDeps
): Promise<WatchTickResult> {
  const now = deps.now?.() ?? new Date();
  const watch = await deps.store.getWatch({ id: args.watchId });

  if (!watch) return { outcome: "missing" };

  // Terminal already, so only the delivery may be owed. Runs before the claim so a
  // retry after a crash between the transition and the append still delivers.
  if (isTerminalWatchStatus(watch.status)) {
    if (isWatchDeliveryOwed(watch.deliveryStatus)) {
      const delivered = await deliverWake(deps, watch);
      return { outcome: delivered ? "delivered_only" : "already_delivering" };
    }
    return { outcome: "already_terminal" };
  }

  // Delivery-only invocations never decide anything, so no generation is claimed.
  if (args.deliverOnly) {
    logger.info("dashboard-agent watch delivery has nothing to deliver", {
      watchId: watch.id,
      status: watch.status,
    });
    return { outcome: "nothing_to_deliver" };
  }

  // The claim is resumable (previous generation or this one) and refuses only once the
  // row has moved past it. A resumed tick re-runs the generation; every write is guarded.
  const claimed = await deps.store.claimWatchTick({
    id: watch.id,
    generation: args.tick,
  });

  if (!claimed) {
    logger.info("dashboard-agent watch tick is stale; exiting", {
      watchId: watch.id,
      tick: args.tick,
      tickCount: watch.tickCount,
    });
    return { outcome: "stale" };
  }

  // The claimed row is the authority on expiry from here on, not the clock the check
  // ran on.
  const final = claimed.expiresAt.getTime() <= now.getTime();
  const check = await deps.check({ watch: claimed, final });

  if (check.kind === "revoked") {
    logger.info("dashboard-agent watch check refused; exiting", {
      watchId: claimed.id,
      code: check.code,
    });
    return { outcome: "revoked" };
  }

  if (check.kind === "unavailable") {
    if (!final) {
      // The generation is spent and the result isn't trusted, so keep watching.
      await deps.store.recordWatchCheck({
        id: claimed.id,
        lastResult: {
          checkFailed: true,
          detail: check.detail,
          previous: lastObservedResult(claimed.lastResult),
        },
      });
      if (check.handOff) return { outcome: "handed_off", tickCount: args.tick };
      await deps.onPending(claimed, args.tick);
      return { outcome: "unavailable", tickCount: args.tick };
    }
    // The deadline passed with the final check unable to run, so the window completed
    // on an unverified observation.
    return resolveAndDeliver(
      deps,
      claimed,
      "window_completed",
      expiredFacts(claimed, { verified: false, reason: "unverified_at_expiry" }),
      check.observed
    );
  }

  // At the boundary only `pending` and `unavailable` become `window_completed`;
  // `satisfied` and `terminal_unsatisfied` resolve as they would before it.
  const resolution = watchResolutionForCheck(check.result, final);

  if (resolution === "condition_met") {
    return resolveAndDeliver(
      deps,
      claimed,
      "condition_met",
      firedFacts(check.facts),
      check.observed
    );
  }

  if (resolution === "condition_impossible") {
    return resolveAndDeliver(
      deps,
      claimed,
      "condition_impossible",
      expiredFacts(claimed, {
        verified: true,
        reason: "terminal_unsatisfied",
        facts: check.facts,
      }),
      check.observed
    );
  }

  if (resolution === "window_completed") {
    return resolveAndDeliver(
      deps,
      claimed,
      "window_completed",
      expiredFacts(claimed, { verified: true, reason: "not_met_by_expiry", facts: check.facts }),
      check.observed
    );
  }

  await deps.store.recordWatchCheck({ id: claimed.id, lastResult: check.facts ?? {} });
  // A hand-off means the group's batch chain keeps looking instead of this one.
  if (check.handOff) return { outcome: "handed_off", tickCount: args.tick };
  await deps.onPending(claimed, args.tick);
  return { outcome: "pending", tickCount: args.tick };
}
