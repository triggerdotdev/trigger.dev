import {
  claimWatchDelivery,
  claimWatchTick,
  createDashboardAgentDb,
  getWatch,
  isTerminalWatchStatus,
  isWatchDeliveryOwed,
  markWatchDelivered,
  recordWatchCheck,
  releaseWatchDelivery,
  transitionWatchCondition,
  WATCH_DELIVERY_CLAIM_STALE_MS,
  type DashboardAgentDbClient,
  type PersistedWatchSpec,
  type Watch,
  type WatchDeliveryClaim,
} from "@internal/dashboard-agent-db";
import {
  watchResolutionForCheck,
  watchResolutionToWireStatus,
  type WatchCheckResult,
  type WatchObservedOutcome,
  type WatchResolution,
} from "@internal/dashboard-agent-contracts";
import { logger, sessions, task, tasks } from "@trigger.dev/sdk";
import type { WatchWakeAction } from "./dashboard-agent";

/**
 * Two tasks over one lifecycle (`runWatchLifecycle`): `watchTick` for one watch,
 * `watchBatchTick` for a group. The webapp evaluates conditions; a tick records them.
 */

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

export type WatchDeliveryDeps = {
  store: Pick<
    WatchTickStore,
    | "getWatch"
    | "transitionWatchCondition"
    | "claimWatchDelivery"
    | "releaseWatchDelivery"
    | "markWatchDelivered"
  >;
  /** Append the wake to the chat's `in` stream. Must throw if the append fails. */
  deliver: (args: { chatId: string; action: WatchWakeAction; watch: Watch }) => Promise<void>;
  /** Send the user's alerts. Best-effort: a failure here must never fail the tick. */
  notifyFired: (watchId: string) => Promise<void>;
  /** Send the agent off to investigate. Best-effort, like `notifyFired`. */
  notifyInvestigate: (watchId: string) => Promise<void>;
  now?: () => Date;
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

export type WatchLifecycleDeps = WatchDeliveryDeps & {
  store: WatchTickStore;
  /** `final` is decided by the claimed row, never by the implementation. */
  check: (args: { watch: Watch; final: boolean }) => Promise<CheckOutcome>;
  /** Keep this watch's chain alive. A no-op in the batch, which reschedules once. */
  onPending: (watch: Watch, tick: number) => Promise<void>;
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
const REVOKED_CODES = new Set(["access_revoked", "cancelled", "not_found"]);

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

// No retry loop: the endpoint dedupes on the watch, and losing an alert beats losing
// the wake.
async function postFired(target: WatchCallbackTarget): Promise<void> {
  await postWatchCallback(target, "fired");
}

type WatchCallbackTarget = { apiOrigin: string; watchId: string; token: string };

// Says only that the wake is delivered; the endpoint decides whether the outcome is
// one the consent covers.
async function postInvestigate(target: WatchCallbackTarget): Promise<void> {
  await postWatchCallback(target, "investigate");
}

async function postWatchCallback(
  target: WatchCallbackTarget,
  path: "fired" | "investigate"
): Promise<void> {
  const origin = target.apiOrigin.replace(/\/$/, "");
  const response = await fetch(
    `${origin}/api/v1/dashboard-agent/watches/${encodeURIComponent(target.watchId)}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    }
  );

  if (!response.ok) {
    throw new Error(`the ${path} callback returned ${response.status}`);
  }
}

function firedFacts(facts: Record<string, unknown> | undefined): Record<string, unknown> {
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
async function deliverWake(deps: WatchDeliveryDeps, watch: Watch): Promise<boolean> {
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
  try {
    await deps.deliver({
      chatId: claimed.chatId,
      action: wakeAction(claimed, facts),
      watch: claimed,
    });
  } catch (error) {
    await deps.store.releaseWatchDelivery({ id: claimed.id, claimId });
    throw error;
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
        lastResult: { checkFailed: true, detail: check.detail, previous: claimed.lastResult },
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
  outcome: "ticked" | "stale";
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
  const response = await deps.checkBatch(payload);

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

async function postBatchCheck(payload: WatchBatchTickPayload): Promise<WatchBatchCheckResponse> {
  const origin = payload.apiOrigin.replace(/\/$/, "");
  const response = await fetch(`${origin}/api/v1/dashboard-agent/watches/batch-check`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${payload.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      environmentId: payload.environmentId,
      cadenceMinutes: payload.cadenceMinutes,
      epoch: payload.epoch,
      tick: payload.tick,
    }),
  });

  const body = (await response.json().catch(() => undefined)) as
    | (WatchBatchCheckResponse & { error?: string })
    | undefined;

  if (!response.ok) {
    // A throw, not an empty batch: rescheduling as if nothing was due would skip the
    // whole group.
    throw new Error(body?.error ?? `the batch check returned ${response.status}`);
  }

  return body ?? {};
}

// One connection pool per worker process.
let dbClient: DashboardAgentDbClient | undefined;
export function getWatchDb(): DashboardAgentDbClient {
  if (!dbClient) {
    const connectionString = process.env.DASHBOARD_AGENT_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DASHBOARD_AGENT_DATABASE_URL (or DATABASE_URL) must be set for the watch task"
      );
    }
    dbClient = createDashboardAgentDb(connectionString, { max: 2 });
  }
  return dbClient;
}

/**
 * Appends a `trigger: "action"` record, which fires `onAction` and nothing else.
 * `metadata` is the agent's `clientData` and carries no delegated token.
 */
export async function appendWakeToSession(args: {
  chatId: string;
  action: WatchWakeAction;
  watch: Watch;
}): Promise<void> {
  const metadata = {
    userId: args.watch.userId,
    organizationId: args.watch.organizationId,
    projectId: args.watch.projectId,
    environmentId: args.watch.environmentId,
    // The external ref a consented investigation is scoped by.
    ...(args.watch.projectRef ? { projectRef: args.watch.projectRef } : {}),
  };

  const send = () =>
    sessions.open(args.chatId).in.send({
      kind: "message",
      payload: {
        chatId: args.chatId,
        trigger: "action",
        action: args.action,
        metadata,
      },
    });

  try {
    await send();
  } catch (error) {
    // A chat born from the configuration card has no session yet, so create it
    // (idempotent on externalId) and retry once.
    if (!isSessionNotFound(error)) throw error;
    await sessions.start({
      type: "chat.agent",
      externalId: args.chatId,
      taskIdentifier: "dashboard-agent",
      triggerConfig: {
        basePayload: { trigger: "preload", chatId: args.chatId, metadata },
      },
    });
    await send();
  }
}

function isSessionNotFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const e = error as { name?: string; status?: number };
  return e.name === "TriggerApiError" && e.status === 404;
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

function watchStore(db: DashboardAgentDbClient["db"]): WatchTickStore {
  return {
    getWatch: (params) => getWatch(db, params),
    claimWatchTick: (params) => claimWatchTick(db, params),
    transitionWatchCondition: (params) => transitionWatchCondition(db, params),
    claimWatchDelivery: (params) => claimWatchDelivery(db, params),
    releaseWatchDelivery: (params) => releaseWatchDelivery(db, params),
    markWatchDelivered: (params) => markWatchDelivered(db, params),
    recordWatchCheck: (params) => recordWatchCheck(db, params),
  };
}

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
