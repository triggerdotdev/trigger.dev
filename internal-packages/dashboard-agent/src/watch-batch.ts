import type { WatchCheckResult, WatchObservedOutcome } from "@internal/dashboard-agent-contracts";
import { logger } from "@trigger.dev/sdk";
import type { WatchDeliveryDeps, WatchTickOutcome, WatchTickStore } from "./watch-delivery";
import { REVOKED_CODES, runWatchLifecycle, type CheckOutcome } from "./watch-lifecycle";

// The batch tick: one run per (environment, cadence), for every watch in it.

export type WatchBatchTickPayload = {
  environmentId: string;
  cadenceMinutes: number;
  apiOrigin: string;
  /**
   * Names the (environment, cadence) and carries no authority: the batch check
   * re-authorizes every watch's initiating user against that watch's own scope.
   */
  token: string;
  /** The chain incarnation this run belongs to. A mismatch means it owns nothing. */
  epoch: number;
  /** The tick generation this run owns inside `epoch`, starting at 1. */
  tick: number;
};

export type WatchBatchCheckEntry = {
  watchId: string;
  token: string;
  /** The generation to claim for this watch (its `tickCount + 1` when listed). */
  tick: number;
  /** The row is already resolved and its wake is owed, so the group recovers it. */
  deliverOnly?: boolean;
  result?: WatchCheckResult;
  facts?: Record<string, unknown>;
  observed?: WatchObservedOutcome;
  /** `access_revoked` / `cancelled` / `not_found`, instead of a result. */
  code?: string;
  error?: string;
};

export type WatchBatchCheckResponse = {
  /** This run's epoch/generation is not the chain's, so it owns nothing and exits. */
  stale?: boolean;
  watches?: WatchBatchCheckEntry[];
  /** Whether the group still has active watches, i.e. whether to tick again. */
  continues?: boolean;
};

export type WatchBatchTickDeps = {
  store: WatchTickStore;
  checkBatch: (payload: WatchBatchTickPayload) => Promise<WatchBatchCheckResponse>;
  deliver: WatchDeliveryDeps["deliver"];
  notifyFired: (target: { watchId: string; token: string }) => Promise<void>;
  notifyInvestigate: (target: { watchId: string; token: string }) => Promise<void>;
  reschedule: (
    payload: WatchBatchTickPayload,
    options: { delay: string; idempotencyKey: string }
  ) => Promise<unknown>;
  now?: () => Date;
  /** How many watches are resolved at once. Defaults to {@link BATCH_CONCURRENCY}. */
  concurrency?: number;
};

export type WatchBatchTickResult = {
  // `unavailable`: the check phase itself couldn't run, so the group learned nothing.
  outcome: "ticked" | "stale" | "unavailable";
  results: Array<{ watchId: string; outcome?: WatchTickOutcome; error?: string }>;
  rescheduled: boolean;
};

const BATCH_CONCURRENCY = 8;

/** `mapper` over `items`, at most `limit` in flight. Order is preserved. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * One tick of a whole (environment, cadence) group. Nothing here guards against a
 * double fire: the terminal transition and the delivery claim do.
 */
export async function runWatchBatchTick(
  payload: WatchBatchTickPayload,
  deps: WatchBatchTickDeps
): Promise<WatchBatchTickResult> {
  let response: WatchBatchCheckResponse;
  try {
    response = await deps.checkBatch(payload);
  } catch (error) {
    // A check failure is never a verdict: the group learned nothing, so nothing is
    // recorded — no watch was looked at — and the chain ticks on to try again.
    logger.error("dashboard-agent watch batch check is unavailable; ticking on", {
      environmentId: payload.environmentId,
      cadenceMinutes: payload.cadenceMinutes,
      epoch: payload.epoch,
      tick: payload.tick,
      error: (error as Error).message,
    });
    await scheduleNextBatchTick(payload, deps);
    return { outcome: "unavailable", results: [], rescheduled: true };
  }

  if (response.stale) {
    logger.info("dashboard-agent watch batch is stale; exiting", {
      environmentId: payload.environmentId,
      cadenceMinutes: payload.cadenceMinutes,
      epoch: payload.epoch,
      tick: payload.tick,
    });
    return { outcome: "stale", results: [], rescheduled: false };
  }

  const entries = response.watches ?? [];
  const results = await mapWithConcurrency(
    entries,
    deps.concurrency ?? BATCH_CONCURRENCY,
    (entry) => resolveBatchEntry(payload, deps, entry)
  );

  // Before the rethrow below, so the chain survives a watch that keeps failing.
  let rescheduled = false;
  if (response.continues) {
    await scheduleNextBatchTick(payload, deps);
    rescheduled = true;
  }

  const failed = results.filter((result) => result.error !== undefined);
  if (failed.length > 0) {
    // Safe to retry the whole batch: the chain's claim is resumable and the check hands
    // back the owed wakes again.
    throw new Error(
      `${failed.length} of ${entries.length} watches failed their tick (${failed
        .map((result) => result.watchId)
        .join(", ")})`
    );
  }

  return { outcome: "ticked", results, rescheduled };
}

// The successor's generation comes from this run's own, and rides in the idempotency
// key, so a resumed or duplicated tick schedules the same successor once.
async function scheduleNextBatchTick(
  payload: WatchBatchTickPayload,
  deps: WatchBatchTickDeps
): Promise<void> {
  const next = payload.tick + 1;
  await deps.reschedule(
    { ...payload, tick: next },
    {
      delay: `${payload.cadenceMinutes}m`,
      // Keyed on the epoch too, so a re-armed chain can't collide with its
      // predecessor's keys.
      idempotencyKey: `watch-batch:${payload.environmentId}:${payload.cadenceMinutes}:${payload.epoch}:tick:${next}`,
    }
  );
}

/** One watch of a batch: each resolves in its own try, so a failure isolates. */
async function resolveBatchEntry(
  payload: WatchBatchTickPayload,
  deps: WatchBatchTickDeps,
  entry: WatchBatchCheckEntry
): Promise<{ watchId: string; outcome?: WatchTickOutcome; error?: string }> {
  const target = { apiOrigin: payload.apiOrigin, watchId: entry.watchId, token: entry.token };
  try {
    const result = await runWatchLifecycle(
      { watchId: entry.watchId, tick: entry.tick, deliverOnly: entry.deliverOnly },
      {
        store: deps.store,
        deliver: deps.deliver,
        notifyFired: () => deps.notifyFired(target),
        notifyInvestigate: () => deps.notifyInvestigate(target),
        now: deps.now,
        check: async () => batchCheckOutcome(entry),
        // The group's single reschedule covers every watch in it.
        onPending: async () => {},
      }
    );
    return { watchId: entry.watchId, outcome: result.outcome };
  } catch (error) {
    logger.error("dashboard-agent watch batch: a watch failed its tick", {
      watchId: entry.watchId,
      environmentId: payload.environmentId,
      error: (error as Error).message,
    });
    return { watchId: entry.watchId, error: (error as Error).message };
  }
}

function batchCheckOutcome(entry: WatchBatchCheckEntry): CheckOutcome {
  if (entry.code && REVOKED_CODES.has(entry.code)) return { kind: "revoked", code: entry.code };
  if (!entry.result || entry.result === "unavailable") {
    return { kind: "unavailable", detail: entry.error, observed: entry.observed };
  }
  return {
    kind: "result",
    result: entry.result,
    facts: entry.facts,
    observed: entry.observed,
  };
}
