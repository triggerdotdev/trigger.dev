import {
  isTerminalWatchStatus,
  isWatchDeliveryOwed,
  WATCH_DELIVERY_CLAIM_STALE_MS,
  type PersistedWatchSpec,
  type Watch,
  type WatchDeliveryClaim,
} from "@internal/dashboard-agent-db";
import {
  watchResolutionToWireStatus,
  type WatchObservedOutcome,
  type WatchResolution,
} from "@internal/dashboard-agent-contracts";
import { logger } from "@trigger.dev/sdk";
import type { WatchWakeAction } from "./dashboard-agent";

/**
 * The delivery half of a watch: the terminal transition, the claim that makes exactly
 * one deliverer append the wake, and the facts each outcome carries.
 */

export type WatchTickStore = {
  getWatch(params: { id: string }): Promise<Watch | null>;
  claimWatchTick(params: { id: string; generation: number }): Promise<Watch | null>;
  transitionWatchCondition(params: {
    id: string;
    resolution: WatchResolution;
    observedOutcome?: WatchObservedOutcome | null;
    lastResult?: Record<string, unknown> | null;
  }): Promise<Watch | null>;
  /**
   * Take the wake. Only the returned row may be appended, and only while its
   * `claimId` is still the row's: that token fences the two writes below.
   */
  claimWatchDelivery(params: { id: string; staleBefore: Date }): Promise<WatchDeliveryClaim | null>;
  /** Hand the wake back after a failed append, so the retry can re-claim it. */
  releaseWatchDelivery(params: { id: string; claimId: string }): Promise<Watch | null>;
  markWatchDelivered(params: { id: string; claimId: string }): Promise<Watch | null>;
  recordWatchCheck(params: {
    id: string;
    lastResult?: Record<string, unknown> | null;
  }): Promise<{ tickCount: number; lastCheckedAt: Date | null } | null>;
};

type WatchWakeAck = { appended: boolean };

export type WatchDeliveryDeps = {
  store: Pick<
    WatchTickStore,
    | "getWatch"
    | "transitionWatchCondition"
    | "claimWatchDelivery"
    | "releaseWatchDelivery"
    | "markWatchDelivered"
  >;
  /** Must throw, or report `{ appended: false }`, if the append fails. */
  deliver: (args: {
    chatId: string;
    action: WatchWakeAction;
    watch: Watch;
  }) => Promise<void | WatchWakeAck>;
  /** Send the user's alerts. Best-effort: a failure here must never fail the tick. */
  notifyFired: (watchId: string) => Promise<void>;
  /** Send the agent off to investigate. Best-effort, like `notifyFired`. */
  notifyInvestigate: (watchId: string) => Promise<void>;
  now?: () => Date;
};

export type WatchTickOutcome =
  | "missing"
  | "already_terminal"
  | "delivered_only"
  // The wake is owed but another invocation holds the delivery claim, so this one
  // must not append: exactly one wake reaches the chat.
  | "already_delivering"
  // A late duplicate: the row has moved past this invocation's generation.
  | "stale"
  // A `deliverOnly` invocation on a row that isn't terminal yet. It must not decide
  // an outcome.
  | "nothing_to_deliver"
  | "revoked"
  | "unavailable"
  | "pending"
  // A batch chain now polls this watch's group, so the per-watch chain stops here
  // instead of rescheduling itself.
  | "handed_off"
  | "fired"
  | "expired";

export type WatchTickResult = { outcome: WatchTickOutcome; tickCount?: number };

export function firedFacts(facts: Record<string, unknown> | undefined): Record<string, unknown> {
  return { verified: true, ...(facts ?? {}) };
}

// An unverified expiry must not claim the thing didn't happen, so it carries the row's
// last observation instead.
export function expiredFacts(
  watch: Watch,
  args: {
    verified: boolean;
    reason: string;
    facts?: Record<string, unknown>;
  }
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

// `type` and `id` keep the two-value `fired`/`expired` encoding, which persisted wakes
// and dedup keys depend on. The meaning travels in `resolution` and `observed`.
function wakeAction(watch: Watch, facts: Record<string, unknown>): WatchWakeAction {
  const spec = watch.spec as PersistedWatchSpec;
  return {
    type: watch.status === "fired" ? "watch.fired" : "watch.expired",
    // Stable per (watch, outcome): a redelivered wake never narrates twice.
    id: `watch:${watch.id}:${watch.status}`,
    watchId: watch.id,
    identity: watch.identity,
    spec,
    facts,
    resolution: watch.resolution ?? undefined,
    observed: watch.observedOutcome ?? undefined,
    note: spec.note,
    investigateOnAttention: watch.investigateOnAttention,
  };
}

/**
 * The claim is the gate: `pending → delivering` in one statement, so exactly one of
 * two racing deliverers appends. The action id only dedups read-then-write.
 */
export async function deliverWake(deps: WatchDeliveryDeps, watch: Watch): Promise<boolean> {
  const now = deps.now?.() ?? new Date();
  const claim = await deps.store.claimWatchDelivery({
    id: watch.id,
    staleBefore: new Date(now.getTime() - WATCH_DELIVERY_CLAIM_STALE_MS),
  });

  if (!claim) {
    logger.info("dashboard-agent watch wake is already being delivered; skipping", {
      watchId: watch.id,
    });
    return false;
  }

  const { watch: claimed, claimId } = claim;
  const facts = (claimed.lastResult ?? {}) as Record<string, unknown>;

  // The release is the recovery, not the failure: its own rejection must never replace
  // the delivery error the caller has to see. The stale claim is swept either way.
  const releaseClaim = async () => {
    try {
      await deps.store.releaseWatchDelivery({ id: claimed.id, claimId });
    } catch (error) {
      logger.warn("dashboard-agent watch: releasing the delivery claim failed", {
        watchId: claimed.id,
        error: (error as Error).message,
      });
    }
  };

  let ack: void | WatchWakeAck;
  try {
    ack = await deps.deliver({
      chatId: claimed.chatId,
      action: wakeAction(claimed, facts),
      watch: claimed,
    });
  } catch (error) {
    await releaseClaim();
    throw error;
  }

  if (ack && ack.appended === false) {
    await releaseClaim();
    throw new Error(`the wake for watch ${claimed.id} wasn't appended`);
  }

  await deps.store.markWatchDelivered({ id: claimed.id, claimId });

  // Outside the wake's failure path: an alert must never fail the delivery.
  if (claimed.status === "fired") {
    try {
      await deps.notifyFired(claimed.id);
    } catch (error) {
      logger.warn("dashboard-agent watch: the fired notification failed", {
        watchId: claimed.id,
        error: (error as Error).message,
      });
    }
  }

  // Fires on any resolved outcome: whether it warrants attention is the webapp's call.
  if (claimed.investigateOnAttention) {
    try {
      await deps.notifyInvestigate(claimed.id);
    } catch (error) {
      logger.warn("dashboard-agent watch: the investigate kick failed", {
        watchId: claimed.id,
        error: (error as Error).message,
      });
    }
  }

  return true;
}

// Only an `active` row transitions, so a check racing the sweeper yields one winner.
// The loser re-reads the row and delivers what the winner decided, if still owed.
export async function resolveAndDeliver(
  deps: WatchDeliveryDeps,
  watch: Watch,
  resolution: WatchResolution,
  facts: Record<string, unknown>,
  observed?: WatchObservedOutcome
): Promise<WatchTickResult> {
  const transitioned = await deps.store.transitionWatchCondition({
    id: watch.id,
    resolution,
    observedOutcome: observed ?? null,
    lastResult: facts,
  });

  if (!transitioned) {
    // Someone else resolved it. Deliver only if that outcome is still owed.
    const current = await deps.store.getWatch({ id: watch.id });
    if (
      current &&
      isTerminalWatchStatus(current.status) &&
      isWatchDeliveryOwed(current.deliveryStatus)
    ) {
      const delivered = await deliverWake(deps, current);
      return { outcome: delivered ? "delivered_only" : "already_delivering" };
    }
    return { outcome: "already_terminal" };
  }

  await deliverWake(deps, transitioned);
  return { outcome: watchResolutionToWireStatus(resolution) };
}
