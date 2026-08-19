import type { PersistedWatchSpec, Watch } from "@internal/dashboard-agent-db";
import type { WatchCheckResult, WatchObservedOutcome } from "@internal/dashboard-agent-contracts";
import { logger, task, tasks } from "@trigger.dev/sdk";
import {
  runWatchBatchTick,
  type WatchBatchTickPayload,
  type WatchBatchTickResult,
} from "./watch-batch";
import type { WatchDeliveryDeps, WatchTickResult, WatchTickStore } from "./watch-delivery";
import { REVOKED_CODES, runWatchLifecycle, type CheckOutcome } from "./watch-lifecycle";
import {
  appendWakeToSession,
  getWatchDb,
  postBatchCheck,
  postFired,
  postInvestigate,
  watchStore,
} from "./watch-task-adapters";

/**
 * Two tasks over one lifecycle (`runWatchLifecycle`): `watchTick` for one watch,
 * `watchBatchTick` for a group. The webapp evaluates conditions; a tick records them.
 */

export type { WatchTickResult, WatchTickStore } from "./watch-delivery";
export type {
  WatchBatchCheckEntry,
  WatchBatchCheckResponse,
  WatchBatchTickDeps,
  WatchBatchTickPayload,
} from "./watch-batch";
export { runWatchBatchTick } from "./watch-batch";

export type WatchTickPayload = {
  watchId: string;
  /** The watch's own token, minted by the webapp. Authorizes the check endpoint. */
  token: string;
  apiOrigin: string;
  /** The tick generation this invocation owns, starting at 1. */
  tick: number;
  /** Wake and mark only: no claim, no check, no reschedule, and `tick` is ignored. */
  deliverOnly?: boolean;
};

export type WatchTickDeps = WatchDeliveryDeps & {
  store: WatchTickStore;
  /** Injected so tests can assert the request the check endpoint receives. */
  fetch: typeof fetch;
  reschedule: (
    payload: WatchTickPayload,
    options: { delay: string; idempotencyKey: string }
  ) => Promise<unknown>;
};

async function postCheck(
  deps: WatchTickDeps,
  payload: WatchTickPayload,
  final: boolean
): Promise<CheckOutcome> {
  const origin = payload.apiOrigin.replace(/\/$/, "");
  let response: Response;
  try {
    response = await deps.fetch(
      `${origin}/api/v1/dashboard-agent/watches/${encodeURIComponent(payload.watchId)}/check`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${payload.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(final ? { final: true } : {}),
      }
    );
  } catch (error) {
    return { kind: "unavailable", detail: (error as Error).message };
  }

  const body = (await response.json().catch(() => undefined)) as
    | {
        result?: WatchCheckResult;
        facts?: Record<string, unknown>;
        observed?: WatchObservedOutcome;
        code?: string;
        error?: string;
        batched?: boolean;
      }
    | undefined;

  if (!response.ok) {
    if (body?.code && REVOKED_CODES.has(body.code)) return { kind: "revoked", code: body.code };
    return {
      kind: "unavailable",
      detail: body?.error ?? `status ${response.status}${body?.code ? ` (${body.code})` : ""}`,
      observed: body?.observed,
      handOff: body?.batched === true,
    };
  }

  if (!body?.result) return { kind: "unavailable", detail: "the check returned no result" };
  if (body.result === "unavailable") {
    return {
      kind: "unavailable",
      detail: body.error,
      observed: body.observed,
      handOff: body.batched === true,
    };
  }
  return {
    kind: "result",
    result: body.result,
    facts: body.facts,
    observed: body.observed,
    handOff: body.batched === true,
  };
}

export function runWatchTick(
  payload: WatchTickPayload,
  deps: WatchTickDeps
): Promise<WatchTickResult> {
  return runWatchLifecycle(
    { watchId: payload.watchId, tick: payload.tick, deliverOnly: payload.deliverOnly },
    {
      store: deps.store,
      deliver: deps.deliver,
      notifyFired: deps.notifyFired,
      notifyInvestigate: deps.notifyInvestigate,
      now: deps.now,
      check: ({ final }) => postCheck(deps, payload, final),
      onPending: (watch) => scheduleNextTick(deps, payload, watch),
    }
  );
}

// The successor's generation comes from the claimed generation, never the row's
// counter, and rides in the idempotency key, so a retry can't fork the chain.
async function scheduleNextTick(
  deps: WatchTickDeps,
  payload: WatchTickPayload,
  watch: Watch
): Promise<void> {
  const spec = watch.spec as PersistedWatchSpec;
  const next = payload.tick + 1;
  await deps.reschedule(
    { ...payload, tick: next },
    {
      delay: `${spec.checkEveryMinutes}m`,
      idempotencyKey: `watch:${watch.id}:tick:${next}`,
    }
  );
}

export const watchTick = task({
  id: "dashboard-agent-watch",
  // Every write is idempotent or guarded and the failure modes are transient, so
  // retry rather than lose the wake.
  retry: { maxAttempts: 5 },
  run: async (payload: WatchTickPayload): Promise<WatchTickResult> => {
    const { db } = getWatchDb();
    const result = await runWatchTick(payload, {
      store: watchStore(db),
      fetch: (input, init) => fetch(input, init),
      deliver: appendWakeToSession,
      notifyFired: () => postFired(payload),
      notifyInvestigate: () => postInvestigate(payload),
      reschedule: (next, options) =>
        tasks.trigger<typeof watchTick>("dashboard-agent-watch", next, options),
    });

    logger.info("dashboard-agent watch ticked", {
      watchId: payload.watchId,
      tick: payload.tick,
      outcome: result.outcome,
      tickCount: result.tickCount,
    });

    return result;
  },
});

export const watchBatchTick = task({
  id: "dashboard-agent-watch-batch",
  // The reschedule happens before the failures are rethrown, so a retry can't end the
  // chain.
  retry: { maxAttempts: 5 },
  run: async (payload: WatchBatchTickPayload): Promise<WatchBatchTickResult> => {
    const { db } = getWatchDb();
    const result = await runWatchBatchTick(payload, {
      store: watchStore(db),
      checkBatch: postBatchCheck,
      deliver: appendWakeToSession,
      notifyFired: (target) => postFired({ apiOrigin: payload.apiOrigin, ...target }),
      notifyInvestigate: (target) => postInvestigate({ apiOrigin: payload.apiOrigin, ...target }),
      reschedule: (next, options) =>
        tasks.trigger<typeof watchBatchTick>("dashboard-agent-watch-batch", next, options),
    });

    logger.info("dashboard-agent watch batch ticked", {
      environmentId: payload.environmentId,
      cadenceMinutes: payload.cadenceMinutes,
      epoch: payload.epoch,
      tick: payload.tick,
      outcome: result.outcome,
      watches: result.results.length,
      rescheduled: result.rescheduled,
    });

    return result;
  },
});
