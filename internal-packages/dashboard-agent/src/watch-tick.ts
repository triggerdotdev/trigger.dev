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
 * The watcher: two tasks over one lifecycle (`runWatchLifecycle`). `watchTick` is
 * one tick of one watch; `watchBatchTick` is one tick of an (environment, cadence)
 * group, so N watches cost one authorization and one shared read instead of N. The
 * only difference is where the check answer comes from and who schedules the next
 * tick. Conditions are evaluated by the webapp, which has the data and the access
 * checks; a tick only records the answer and wakes the chat.
 *
 * Invariants the tests pin:
 *
 * - The row is the authority on expiry, not the clock the check ran on.
 * - `unavailable` is never read as true and never as false: the check itself
 *   couldn't run, so the watch keeps its state and tries again.
 * - Every invocation owns one generation, claimed atomically before anything else.
 *   The claim is resumable, because a claim that refused to resume would leave a
 *   crashed generation with no successor and the watch unchecked until its
 *   deadline. The successor's idempotency key is derived from the generation, so
 *   the chain still can't fork; a late duplicate of an older generation exits
 *   `stale`.
 * - The terminal transition is atomic and one-way, and the delivery is marked only
 *   after the session append is acknowledged. Anything failing before that ack
 *   throws so the platform retries, and the retry finds terminal + an owed
 *   delivery and delivers alone. That is why the terminal branch runs before the
 *   claim.
 * - The wake is claimed atomically (`pending` → `delivering`) and only the winner
 *   appends, because the action id dedups only through a read-then-write on the
 *   transcript, which two concurrent appends can interleave through. The claim is
 *   fenced by a token, so only the deliverer still holding it can release it or
 *   mark it delivered.
 */

/** What the webapp triggers on creation, and what a tick re-triggers on itself. */
export type WatchTickPayload = {
  watchId: string;
  /** The watch's own token, minted by the webapp. Authorizes the check endpoint. */
  token: string;
  apiOrigin: string;
  /** The tick generation this invocation owns, starting at 1. */
  tick: number;
  /**
   * The row has already been resolved by the webapp, so this invocation only wakes
   * the chat and marks the delivery. No claim, no check, no reschedule, and `tick`
   * is ignored. Used by the webapp's watch sweep, which owns the outcome but can't
   * append to a chat's `in` stream itself.
   */
  deliverOnly?: boolean;
};

/** The watch rows this task reads and writes, behind an interface so tests can fake it. */
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
   * Take the wake. Only the row this returns may be appended to the chat, and only
   * while the returned `claimId` is still the row's — that token fences the two
   * writes below.
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

/**
 * Its own deps shape because both a full tick and a delivery-only invocation go
 * through the same transition + append + mark sequence.
 */
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
  /**
   * Tell the webapp a watch fired, so it can send the user's configured alerts.
   * Best-effort: a failure here must never fail the tick, because the wake in the
   * chat is the delivery that matters.
   */
  notifyFired: (watchId: string) => Promise<void>;
  /**
   * Tell the webapp a consented watch has been woken, so it can send the agent off
   * to investigate. The webapp owns that because the investigating turn needs a
   * delegated token only it can mint. Best-effort like `notifyFired`: the wake is
   * already delivered by the time this runs.
   */
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

/** Everything the lifecycle needs that isn't the store. Both tasks build one. */
export type WatchLifecycleDeps = WatchDeliveryDeps & {
  store: WatchTickStore;
  /**
   * The verdict for this watch. `final` is decided by the claimed row, so the
   * implementation is told whether this is the window's boundary evaluation rather
   * than deciding it.
   */
  check: (args: { watch: Watch; final: boolean }) => Promise<CheckOutcome>;
  /**
   * Keep this watch's chain alive after a check that resolved nothing. A no-op in
   * the batch, where one reschedule covers the whole group.
   */
  onPending: (watch: Watch, tick: number) => Promise<void>;
};

/** What one tick did, for the run's output and the tests. */
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

/**
 * The check endpoint's answer, normalized.
 *
 * `handOff` is orthogonal to the verdict: a batch chain now polls this watch's
 * group, so whoever asked should stop keeping its own chain alive. Only the
 * per-watch check endpoint ever sets it.
 */
export type CheckOutcome =
  | {
      kind: "result";
      result: WatchCheckResult;
      facts?: Record<string, unknown>;
      /** What the check saw, the second half of a resolved result. */
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

/**
 * Codes that mean the row is no longer active, so there is nothing left for the
 * tick to transition or deliver. A cancellation is never narrated.
 *
 * Anything else non-2xx is a failed check, so the tick records the failure and
 * keeps watching until the row's own deadline. That includes an unrecognized
 * 401/403: a bad token must not leave the row active forever, holding one of the
 * chat's watch slots.
 */
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
        /** A batch chain now polls this watch's group; stop the per-watch chain. */
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

/**
 * Tell the webapp the watch fired; it owns the alert fan-out. No retry loop,
 * because the endpoint dedupes on the watch and losing an alert is better than
 * losing the wake.
 */
async function postFired(target: WatchCallbackTarget): Promise<void> {
  await postWatchCallback(target, "fired");
}

/**
 * Its own type because a batch tick calls these for many watches, each with the
 * token the batch check handed back for it.
 */
type WatchCallbackTarget = { apiOrigin: string; watchId: string; token: string };

/**
 * Tell the webapp a consented watch has been woken. This call only says the wake is
 * delivered; the endpoint decides whether the outcome is one the consent covers.
 */
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

/**
 * Facts for an expiry. An unverified expiry (the final check couldn't run) must not
 * claim the thing didn't happen, so it carries the last observation instead: the
 * row's `lastCheckedAt` / `lastResult` pair, only ever written together.
 */
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

/**
 * The wake, as the agent receives it. The type and the action id keep the two-value
 * `fired`/`expired` encoding so persisted wakes, dedup keys and banner render keys
 * stay valid; the resolution and the observed outcome carry the real meaning.
 */
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
    // The consent given at creation, so the narration can say the investigation
    // has started. Running it is the wake turn's business, not this task's.
    investigateOnAttention: watch.investigateOnAttention,
  };
}

/**
 * Wake the chat, then mark the delivery. Returns whether this call delivered.
 *
 * The claim is the gate: `pending → delivering` in one statement, so of two
 * deliverers racing on the same resolved row exactly one appends. The stable action
 * id is only the second line of defence, because it dedups through a
 * read-then-write on the transcript that two concurrent appends can interleave
 * through.
 *
 * A failed append gives the claim back and rethrows, so the platform's retry
 * re-claims immediately instead of waiting out the stale window. A deliverer that
 * dies without releasing leaves a `delivering` row for the sweep to recover once the
 * claim is stale. Both writes carry the claim's `claimId`, so a deliverer that hung
 * long enough to be taken over can no longer touch the row.
 *
 * Residual race: the token fences the DB writes, not the session append, so an owner
 * that hung past the stale window can still append late. Accepted because the claim
 * only goes stale after WATCH_DELIVERY_CLAIM_STALE_MS (minutes, against a delivery
 * that takes seconds) and the transcript dedups on the stable action id.
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

  // Outside the wake's failure path: the chat is the delivery this task guarantees,
  // an alert is an extra.
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

  // On any resolved outcome: whether this one warrants attention is the webapp's
  // call, so the tick only reports that a consented watch has been woken. Outside
  // the wake's failure path, like the alert above.
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

/**
 * Resolve the watch and wake the chat. The transition is the gate: only an `active`
 * row transitions, so a check that fires at the same moment the sweeper expires the
 * watch yields exactly one winner. The loser re-reads the row and delivers whatever
 * the winner decided, if that is still owed.
 */
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
    // Someone else resolved it. Deliver only if that outcome is still owed — and
    // only if the delivery claim is ours to take.
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

/**
 * One watch's tick, whoever is driving it. See the module comment for the
 * invariants; the order of the branches below is the algorithm.
 *
 * Shared by the per-watch task and the batch, so the claim, the resolution model,
 * the boundary evaluation, the terminal transition and the fenced wake are the same
 * code on both paths.
 */
export async function runWatchLifecycle(
  args: { watchId: string; tick: number; deliverOnly?: boolean },
  deps: WatchLifecycleDeps
): Promise<WatchTickResult> {
  const now = deps.now?.() ?? new Date();
  const watch = await deps.store.getWatch({ id: args.watchId });

  if (!watch) return { outcome: "missing" };

  // Terminal already, so only the delivery may be owed. This is the path a retried
  // invocation takes after a crash between the transition and the append.
  if (isTerminalWatchStatus(watch.status)) {
    if (isWatchDeliveryOwed(watch.deliveryStatus)) {
      const delivered = await deliverWake(deps, watch);
      return { outcome: delivered ? "delivered_only" : "already_delivering" };
    }
    return { outcome: "already_terminal" };
  }

  // Delivery-only invocations never decide anything, so a non-terminal row exits
  // without claiming a generation.
  if (args.deliverOnly) {
    logger.info("dashboard-agent watch delivery has nothing to deliver", {
      watchId: watch.id,
      status: watch.status,
    });
    return { outcome: "nothing_to_deliver" };
  }

  // Claim this invocation's generation. The claim is resumable: the previous
  // generation (a fresh tick) or this one (a retry resuming after a crash), and it
  // refuses only when the row has moved past this generation. A resumed tick re-runs
  // the whole generation, which is safe because every write it makes is guarded or
  // keyed (see `claimWatchTick`).
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

  // The claimed row is the authority from here on: the state this invocation owns,
  // re-read inside the same statement that claimed it. That includes expiry — past
  // the deadline this is the last check the watch gets, and the endpoint is told so.
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
      // A failed tick: the generation is spent, the result isn't trusted. Keep watching.
      await deps.store.recordWatchCheck({
        id: claimed.id,
        lastResult: { checkFailed: true, detail: check.detail, previous: claimed.lastResult },
      });
      if (check.handOff) return { outcome: "handed_off", tickCount: args.tick };
      await deps.onPending(claimed, args.tick);
      return { outcome: "unavailable", tickCount: args.tick };
    }
    // The final check couldn't run but the deadline passed, so the window completed
    // with an unverified observation. The narration says the condition couldn't be
    // confirmed, not that it didn't happen.
    return resolveAndDeliver(
      deps,
      claimed,
      "window_completed",
      expiredFacts(claimed, { verified: false, reason: "unverified_at_expiry" }),
      check.observed
    );
  }

  // The final evaluation is a real evaluation: `satisfied` and `terminal_unsatisfied`
  // resolve the same way at the boundary as before it, and only `pending` and
  // `unavailable` become `window_completed`.
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
  // The window is still open, so something has to keep looking. A hand-off says the
  // group's batch chain is already doing it.
  if (check.handOff) return { outcome: "handed_off", tickCount: args.tick };
  await deps.onPending(claimed, args.tick);
  return { outcome: "pending", tickCount: args.tick };
}

/**
 * One tick of one watch, over the per-watch check endpoint. The webapp triggers this
 * when a watch is created, and its first check hands the watch over to the group's
 * batch chain.
 */
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

/**
 * Trigger the next tick, `checkEveryMinutes` out.
 *
 * The successor's generation comes from the generation this invocation claimed, never
 * from the row's counter, and it is carried in the idempotency key as well as the
 * payload. So a retry that re-runs this generation triggers the same successor, the
 * key dedups it, and the chain stays single-file.
 */
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
   * The chain's token, minted by the webapp for this (environment, cadence). It
   * carries no authority beyond naming what it is for: the batch check re-authorizes
   * every watch's own initiating user against that watch's own immutable
   * project/environment.
   */
  token: string;
  /** The chain incarnation this run belongs to. A mismatch means it owns nothing. */
  epoch: number;
  /** The tick generation this run owns inside `epoch`, starting at 1. */
  tick: number;
};

/** One watch's verdict inside a batch answer. */
export type WatchBatchCheckEntry = {
  watchId: string;
  /** The watch's own token — the fired / investigate callbacks are per watch. */
  token: string;
  /** The generation to claim for this watch (its `tickCount + 1` when listed). */
  tick: number;
  /**
   * The row is already resolved and its wake is owed. The entry exists so the group's
   * own tick recovers the wake instead of leaving it to the webapp's delivery sweep.
   */
  deliverOnly?: boolean;
  result?: WatchCheckResult;
  facts?: Record<string, unknown>;
  observed?: WatchObservedOutcome;
  /** `access_revoked` / `cancelled` / `not_found`, instead of a result. */
  code?: string;
  error?: string;
};

export type WatchBatchCheckResponse = {
  /**
   * This run's epoch/generation is not the chain's: a duplicate whose successor
   * already ran, or a zombie from before a re-arm. It owns nothing and exits.
   */
  stale?: boolean;
  watches?: WatchBatchCheckEntry[];
  /** Whether the group still has active watches, i.e. whether to tick again. */
  continues?: boolean;
};

export type WatchBatchTickDeps = {
  store: WatchTickStore;
  /** Every due watch's verdict, from one call. */
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

/** What one batch tick did, per watch and as a whole. */
export type WatchBatchTickResult = {
  outcome: "ticked" | "stale";
  results: Array<{ watchId: string; outcome?: WatchTickOutcome; error?: string }>;
  rescheduled: boolean;
};

/**
 * How many watches a batch resolves at once. Small and constant, because the point is
 * that one slow condition can't serialize the group, not to fan out: every watch
 * shares one database and one webapp, and the expensive reads already happened.
 */
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
 * One tick of a whole (environment, cadence) group. One call gets every due watch's
 * verdict, so the environment is authorized once and the shared expensive reads
 * happen once however many watches are watching.
 *
 * Three properties the shape has to keep:
 *
 * - Isolation. Each watch resolves inside its own try, so a failure is recorded
 *   against that watch and the rest of the batch still resolves.
 * - The chain outlives a bad watch. The reschedule happens before the failures are
 *   rethrown, so a watch that fails every attempt can't take the group's polling loop
 *   down with it.
 * - No double-fire, and nothing here is the guard: two overlapping runs both reach a
 *   watch's terminal transition and its delivery claim, and those guarded statements
 *   pick one winner. The chain's epoch/generation claim only keeps the schedule
 *   single-file.
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
        // Keyed on the epoch as well as the generation, so a re-armed chain can
        // never collide with the keys its predecessor already used.
        idempotencyKey: `watch-batch:${payload.environmentId}:${payload.cadenceMinutes}:${payload.epoch}:tick:${next}`,
      }
    );
    rescheduled = true;
  }

  const failed = results.filter((result) => result.error !== undefined);
  if (failed.length > 0) {
    // The retry re-runs the batch: the chain's claim is resumable and the check hands
    // back the owed wakes again.
    throw new Error(
      `${failed.length} of ${entries.length} watches failed their tick (${failed
        .map((result) => result.watchId)
        .join(", ")})`
    );
  }

  return { outcome: "ticked", results, rescheduled };
}

/** One watch of a batch, on the shared lifecycle, isolated from its neighbours. */
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

/**
 * A batch entry as the lifecycle's check answer. The batch check already applied the
 * row's own authority, so this only re-shapes what it said.
 */
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
    // A throw, not an empty batch: an unreadable answer is a failure to check the
    // whole group, so the run must be retried rather than reschedule as if nothing
    // was due.
    throw new Error(body?.error ?? `the batch check returned ${response.status}`);
  }

  return body ?? {};
}

// One connection pool per worker process, separate from the agent's because ticks are
// their own runs.
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
 * One record on the chat's `in` stream carrying `trigger: "action"`, which fires the
 * agent's `onAction` hook and nothing else. The append also ensures a live agent run,
 * so a wake reaches a chat whose run has long since idled out.
 *
 * `metadata` is the agent's `clientData`, rebuilt from the watch's tenancy snapshot.
 * It carries no delegated token, because a wake narrates what the check already
 * established instead of reading anything.
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
    // The external ref a consented investigation is scoped by. The same one a normal
    // turn carries, so a follow-up turn revises that investigation instead of
    // opening a second one.
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
    // A chat born from the configuration card has no session yet, because the card's
    // confirmation is a direct JSONB append. The wake is the first thing that needs
    // one, so create it here (idempotent on externalId) and retry once. Any other
    // failure keeps the claim's retry semantics.
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

/** A 404 from a session call: no Session row exists for this chat id. */
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

/** The store bindings both tasks use. */
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
  // Same reasoning as the per-watch tick. The reschedule happens before the failures
  // are rethrown, so retrying can never be the thing that ends the chain.
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
