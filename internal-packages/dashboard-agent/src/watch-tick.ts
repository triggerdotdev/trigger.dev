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
 * The watcher. Two tasks, one lifecycle.
 *
 * `watchTick` is one tick of ONE watch: the shape a watch is born into (the webapp
 * triggers it when the watch is created) and the shape a wake hand-off takes. Its
 * chain is deliberately short-lived — the first check hands the watch over to the
 * batch (see `handOff` below) and stops rescheduling itself.
 *
 * `watchBatchTick` is one tick of a whole **(environment, cadence) group**, and it
 * is where the polling actually happens. One run per group per cadence: the webapp
 * authorizes the environment once, loads the shared expensive data once (the health
 * report above all), evaluates every due condition, and hands back one verdict per
 * watch. This task then runs the SAME per-watch lifecycle over those verdicts —
 * claim, resolve, wake — concurrently and in isolation. N watches in one
 * environment cost one authorization and one report read instead of N.
 *
 * Everything below the transport is shared: `runWatchLifecycle` is the algorithm,
 * and the only difference between the two tasks is where the check answer comes
 * from and who schedules the next tick.
 *
 * ---
 *
 * One invocation of `watchTick` is one tick of one watch ("tell me when X
 * happens").
 *
 * There is NO model in a tick. The condition is evaluated by the webapp (which
 * has the data and the access checks); the tick's whole job is the lifecycle:
 * ask, record, and — exactly once — wake the chat. The narration is the agent's
 * job, and it happens in the agent run, from the wake action this task appends
 * to the chat's `in` stream.
 *
 * Same shape as the eval task: its own lazy connection pool (ticks are their own
 * runs and land on other workers than the agent), and the whole algorithm behind
 * an injectable `deps` seam so the tests drive it with a fake store, a fake
 * fetch, and a fake session append instead of mocks.
 *
 * Ordering rules that the tests pin, all of them load-bearing:
 *
 * - The row is the authority on expiry, not the clock the check ran on.
 * - `unavailable` is never read as true and never as false: the check itself
 *   couldn't run, so the watch keeps its state and tries again.
 * - Every invocation owns ONE generation, carried in the payload and claimed
 *   atomically before anything else happens. The claim is resumable: a retry of
 *   the invocation that owns a generation re-runs it (the successor's idempotency
 *   key is derived from the generation, so the chain still can't fork), while a
 *   late duplicate of an older generation claims nothing and exits `stale`. A
 *   claim that refused to resume would leave a crashed generation with no
 *   successor and the watch unchecked until its deadline.
 * - The terminal transition is atomic and one-way (`active` → fired/expired,
 *   delivery `pending`), and `markWatchDelivered` happens ONLY after the session
 *   append is acknowledged. Anything failing before that ack throws, so the
 *   platform retries the invocation; the retry finds terminal + an owed delivery
 *   and performs the delivery alone — which is why the terminal branch runs BEFORE
 *   the claim.
 * - The wake itself is claimed atomically (`pending` → `delivering`) and only the
 *   claim's winner appends. Two invocations that both get past the tick claim — a
 *   resumable generation makes that possible — then race on the terminal
 *   transition, and the loser re-reads a row whose delivery is still owed; without
 *   the delivery claim they would BOTH wake the chat, since the action id dedups
 *   only through a read-then-write on the transcript. The claim is fenced by a
 *   token, so releasing it and marking it delivered can only ever be done by the
 *   deliverer that still holds it.
 */

/** What the webapp triggers on creation, and what a tick re-triggers on itself. */
export type WatchTickPayload = {
  watchId: string;
  /** The watch's own token, minted by the webapp. Authorizes the check endpoint. */
  token: string;
  apiOrigin: string;
  /**
   * The tick generation this invocation owns, starting at 1. Produced only by the
   * webapp's `scheduleWatchTick` (watch creation) and by this task's own
   * reschedule, and claimed once via `claimWatchTick`.
   */
  tick: number;
  /**
   * Delivery only: the row has ALREADY been resolved by the webapp, and all this
   * invocation does is wake the chat and mark the delivery. No claim, no check, no
   * reschedule — `tick` is ignored.
   *
   * This is the seam the webapp's watch sweep uses. The webapp owns the outcome
   * (it re-authorizes the user and runs the final check); appending to a chat's
   * `in` stream is the agent project's capability, so the delivery is handed back
   * here instead of being duplicated there.
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
 * Resolving a watch and waking the chat — kept as its own deps shape because both
 * the full tick and a delivery-only invocation go through the same transition +
 * append + mark sequence.
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
   * Tell the webapp a watch fired, so it can send the user's configured alerts
   * (email/Slack/webhook). Best-effort: a failure here must never fail the tick —
   * the wake in the chat is the delivery that matters.
   */
  notifyFired: (watchId: string) => Promise<void>;
  /**
   * Tell the webapp a consented watch has been woken, so the agent can be sent off
   * to conduct the investigation the wake announced. The webapp owns that: the
   * investigating turn needs a delegated token for the watch's user, which only it
   * can mint. Best-effort for the same reason as `notifyFired` — the wake is already
   * delivered by the time this runs, and nothing here may retry or invalidate it.
   */
  notifyInvestigate: (watchId: string) => Promise<void>;
  now?: () => Date;
};

export type WatchTickDeps = WatchDeliveryDeps & {
  store: WatchTickStore;
  /** Injected so tests can assert the request the check endpoint receives. */
  fetch: typeof fetch;
  /** Trigger the next tick. */
  reschedule: (
    payload: WatchTickPayload,
    options: { delay: string; idempotencyKey: string }
  ) => Promise<unknown>;
};

/**
 * The lifecycle's own seams — everything the algorithm needs that isn't the store.
 * Both tasks build one of these: the per-watch tick posts to the check endpoint and
 * reschedules itself, the batch reads a verdict the group's single check already
 * produced and lets the batch do the rescheduling.
 */
export type WatchLifecycleDeps = WatchDeliveryDeps & {
  store: WatchTickStore;
  /**
   * The verdict for this watch. `final` is decided by the CLAIMED row, so the
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
  // The row has moved past the generation this invocation carries: a late
  // duplicate whose successor already ran.
  | "stale"
  // A `deliverOnly` invocation on a row that isn't terminal yet: nothing to wake
  // the chat about, and this invocation must not decide an outcome.
  | "nothing_to_deliver"
  | "revoked"
  | "unavailable"
  | "pending"
  // The check answered AND told us a batch chain is now polling this watch's
  // (environment, cadence) group. The per-watch chain stops here rather than
  // rescheduling itself — the group's single tick run has the watch from now on.
  | "handed_off"
  | "fired"
  | "expired";

export type WatchTickResult = { outcome: WatchTickOutcome; tickCount?: number };

/**
 * The check endpoint's answer, normalized.
 *
 * `handOff` is orthogonal to the verdict: it says a batch chain now polls this
 * watch's group, so whoever asked should stop keeping its own chain alive. Only the
 * per-watch check endpoint ever sets it.
 */
export type CheckOutcome =
  | {
      kind: "result";
      result: WatchCheckResult;
      facts?: Record<string, unknown>;
      /** What the check SAW — the second half of a resolved result (§4.2). */
      observed?: WatchObservedOutcome;
      handOff?: boolean;
    }
  // The row is already over and the webapp knows it: the tick exits without
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
 * Codes that mean the ROW is no longer active, so there is nothing left for the
 * tick to transition or deliver:
 *
 * - `access_revoked` — the endpoint re-authorized the user, failed, and cancelled
 *   the watch itself before returning (a cancellation is never narrated).
 * - `cancelled` — the row was already cancelled (chat deleted, user asked).
 * - `not_found` — the row is gone.
 *
 * Anything else non-2xx is a failed check, i.e. `unavailable`: the tick records
 * the failure and keeps watching, and the row's own deadline (or the expiry
 * sweeper) ends the watch. That includes an unrecognized 401/403 — a bad token or
 * an unexpected refusal must not leave the row active forever, holding one of the
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
 * Tell the webapp the watch fired. The webapp owns the alert fan-out; this call
 * only says "it happened", and the row it reads is the authority on the rest.
 *
 * Same token as the check endpoint. No retry loop: the endpoint dedupes on the
 * watch, so a later tick or invocation retry can repeat it harmlessly, and losing
 * the alert is better than losing the wake.
 */
async function postFired(target: WatchCallbackTarget): Promise<void> {
  await postWatchCallback(target, "fired");
}

/**
 * What a per-watch callback needs. Its own type because a batch tick calls these
 * for many watches, each with the token the batch check handed back for it.
 */
type WatchCallbackTarget = { apiOrigin: string; watchId: string; token: string };

/**
 * Tell the webapp a consented watch has been woken, so it can send the agent off to
 * conduct the investigation. Same token, same "the row is the authority" contract:
 * this call says only that the wake is delivered, and the endpoint decides whether
 * the outcome is one the consent covers.
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

/** Facts for a watch that resolved on a check. */
function firedFacts(facts: Record<string, unknown> | undefined): Record<string, unknown> {
  return { verified: true, ...(facts ?? {}) };
}

/**
 * Facts for an expiry. When the FINAL check came back `unavailable` the watch
 * still expires — but the narration must not claim the thing didn't happen, so
 * the facts say the condition couldn't be verified at expiry and carry the last
 * observation we do have: the row's `lastCheckedAt` / `lastResult` pair, which is
 * only ever written together, by the check that observed it.
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
 * The wake, as the agent receives it.
 *
 * The transport keeps its as-built two-value encoding (§7.5, binding): the type
 * and the action id still say `fired`/`expired`, so persisted wakes, dedup keys
 * and banner render keys stay valid. The RESOLUTION and the OBSERVED OUTCOME
 * travel in the payload beside them — that is where the meaning lives now.
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
    // The consent given at creation. The wake carries it so the narration can
    // say the investigation has started — the investigation itself is the wake
    // turn's business, never this task's (§6).
    investigateOnAttention: watch.investigateOnAttention,
  };
}

/**
 * Wake the chat, then mark the delivery. Returns whether THIS call delivered.
 *
 * The claim is the gate: `pending → delivering` in one statement, so of two
 * deliverers racing on the same resolved row exactly one appends and the other
 * returns false. The stable action id is still the second line of defence, but it
 * dedups only through a read-then-write on the transcript, which two concurrent
 * appends can interleave through — so it can't be the first.
 *
 * A failed append gives the claim back and rethrows: the invocation fails, the
 * platform retries it, and the retry re-claims immediately instead of waiting out
 * the stale window. A deliverer that dies without releasing leaves a `delivering`
 * row, which the sweep recovers once the claim is stale.
 *
 * Both of those writes carry the claim's `claimId`, so they only ever touch the
 * claim this call owns: a deliverer that hung long enough to be taken over comes
 * back to a row holding a different token, and its release and its mark do nothing.
 *
 * Known residual race: the token fences the DB writes, not the session append
 * itself — an owner that hung PAST the stale window can still fire its append
 * late, concurrently with the takeover's. Accepted because every layer has to
 * fail at once for a duplicate to surface: the claim goes stale only after
 * WATCH_DELIVERY_CLAIM_STALE_MS (minutes, vs a delivery that takes seconds),
 * the action id is stable across deliverers, and the transcript dedups on it.
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

  // The alerts the user configured, after the wake and outside its failure path:
  // the chat is the delivery this task guarantees, an alert is an extra.
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

  // The consented investigation, on any resolved outcome: whether THIS one is an
  // attention outcome is the webapp's call (it has the contracts mapping and the
  // row), so the tick only reports that a consented watch has been woken. Outside
  // the wake's failure path, like the alerts above.
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
 * Resolve the watch and wake the chat. The transition is the gate: only an
 * `active` row transitions, so a check that fires at the same moment the sweeper
 * expires the watch yields exactly one winner. The loser re-reads the row and
 * delivers whatever the winner decided, if that's still owed.
 *
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
 * invariants; the order of the branches below IS the algorithm.
 *
 * Shared verbatim by the per-watch task and the batch: batching changed WHERE the
 * check answer comes from and who schedules the next tick, and deliberately nothing
 * else — the claim, the resolution model, the boundary evaluation, the terminal
 * transition and the fenced wake are all the same code on both paths.
 */
export async function runWatchLifecycle(
  args: { watchId: string; tick: number; deliverOnly?: boolean },
  deps: WatchLifecycleDeps
): Promise<WatchTickResult> {
  const now = deps.now?.() ?? new Date();
  const watch = await deps.store.getWatch({ id: args.watchId });

  if (!watch) return { outcome: "missing" };

  // Terminal already. The only thing left to do is the delivery, if it's owed —
  // this is the path a retried invocation takes after a crash between the
  // transition and the append.
  if (isTerminalWatchStatus(watch.status)) {
    if (isWatchDeliveryOwed(watch.deliveryStatus)) {
      const delivered = await deliverWake(deps, watch);
      return { outcome: delivered ? "delivered_only" : "already_delivering" };
    }
    return { outcome: "already_terminal" };
  }

  // Delivery-only invocations never decide anything: if the row isn't terminal,
  // there is nothing owed and this exits without claiming a generation.
  if (args.deliverOnly) {
    logger.info("dashboard-agent watch delivery has nothing to deliver", {
      watchId: watch.id,
      status: watch.status,
    });
    return { outcome: "nothing_to_deliver" };
  }

  // Claim this invocation's generation. The claim is resumable: it lands on the
  // previous generation (a fresh tick) or on this one (a retry of the invocation
  // that owns it, resuming after a crash), and refuses only when the row has moved
  // past this generation — i.e. this is a late duplicate whose successor already
  // ran. A resumed tick re-runs the whole generation, which is safe because every
  // write it makes is guarded or keyed (see `claimWatchTick`).
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

  // The claimed row is the authority from here on — it is the state this
  // invocation owns, re-read inside the same statement that claimed it.

  // The ROW is the authority on expiry, not the check. Past the deadline this is
  // the last check the watch gets, and the endpoint is told so.
  const final = claimed.expiresAt.getTime() <= now.getTime();
  const check = await deps.check({ watch: claimed, final });

  if (check.kind === "revoked") {
    // The row is cancelled or gone, so there is nothing to transition or deliver.
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
    // The final check couldn't run, but the deadline still passed: the watch
    // expires, and the narration says the condition couldn't be verified.
    // The window completed without a usable final read: `window_completed`, but
    // the observation is unverified, so the presentation says the condition
    // couldn't be confirmed rather than that it didn't happen.
    return resolveAndDeliver(
      deps,
      claimed,
      "window_completed",
      expiredFacts(claimed, { verified: false, reason: "unverified_at_expiry" }),
      check.observed
    );
  }

  // §7.4 (binding): the final evaluation is a real evaluation. `satisfied` and
  // `terminal_unsatisfied` resolve the same way at the boundary as before it —
  // only `pending` and `unavailable` become `window_completed`.
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
    // Not a failure: it can never happen now. Stop checking and say so.
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
  // The condition hasn't happened and the window is still open, so SOMETHING has to
  // keep looking. A hand-off says the group's batch chain is already doing it.
  if (check.handOff) return { outcome: "handed_off", tickCount: args.tick };
  await deps.onPending(claimed, args.tick);
  return { outcome: "pending", tickCount: args.tick };
}

/**
 * One tick of one watch, over the per-watch check endpoint. The shape a watch is
 * born into: the webapp triggers this when the watch is created, and its first
 * check hands the watch over to the group's batch chain.
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
 * The successor's generation is `payload.tick + 1` — derived from the generation
 * THIS invocation claimed, never from the row's counter, and carried both in the
 * payload and in the idempotency key `watch:{id}:tick:{n}`. So a retry that
 * re-runs this generation triggers the same successor, the key dedups it, and the
 * chain stays single-file; only once that successor has itself claimed does an old
 * generation become stale.
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

// ---------------------------------------------------------------------------
// The batch tick — one run per (environment, cadence), for every watch in it.
// ---------------------------------------------------------------------------

/** What a batch tick carries: the group, the chain it belongs to, its generation. */
export type WatchBatchTickPayload = {
  environmentId: string;
  cadenceMinutes: number;
  apiOrigin: string;
  /**
   * The CHAIN's token, minted by the webapp for this (environment, cadence). Like a
   * watch token it carries no authority beyond naming what it is for: the batch
   * check re-authorizes every watch's own initiating user against that watch's own
   * immutable project/environment, one authorization per distinct user.
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
   * The row is already resolved and its wake is owed: no check ran and none is
   * wanted, this entry exists so the group's own tick recovers the wake rather than
   * leaving it to the webapp's five-minute delivery sweep.
   */
  deliverOnly?: boolean;
  result?: WatchCheckResult;
  facts?: Record<string, unknown>;
  observed?: WatchObservedOutcome;
  /** `access_revoked` / `cancelled` / `not_found`, instead of a result. */
  code?: string;
  error?: string;
};

/** What the batch check endpoint answers. */
export type WatchBatchCheckResponse = {
  /**
   * This run's epoch/generation is not the chain's — a duplicate whose successor
   * already ran, or a zombie from before a re-arm. It owns nothing and exits.
   */
  stale?: boolean;
  watches?: WatchBatchCheckEntry[];
  /** Whether the group still has active watches, i.e. whether to tick again. */
  continues?: boolean;
};

export type WatchBatchTickDeps = {
  store: WatchTickStore;
  /** Every due watch's verdict, from ONE call. */
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
 * How many watches a batch resolves at once. Small and constant: the point is that
 * one slow condition can't serialize the group, not to fan out — every watch in the
 * batch shares one database and one webapp, and the expensive reads already happened
 * once, before this task saw the answer.
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
 * One tick of a whole (environment, cadence) group.
 *
 * The economics of the feature live in the first line: ONE call gets every due
 * watch's verdict, so the environment is authorized once and the shared expensive
 * reads (the health report above all) happen once no matter how many watches are
 * watching. Everything after it is the per-watch lifecycle, unchanged.
 *
 * Three properties the shape has to keep, and how:
 *
 * - **Isolation.** Each watch is resolved inside its own try, so an exception, a
 *   refusal, or a wake that wouldn't append is recorded against that watch and the
 *   rest of the batch still resolves.
 * - **The chain outlives a bad watch.** The reschedule happens BEFORE the failures
 *   are rethrown, so a watch that fails every attempt can't take its group's polling
 *   loop down with it — the run fails (visibly, and retried), the chain continues.
 * - **No double-fire.** Nothing here is the guard: two overlapping batch runs both
 *   reach the same watch's terminal transition and its delivery claim, and those —
 *   the same guarded statements a per-watch tick relies on — pick one winner. The
 *   chain's epoch/generation claim (in the batch check) only keeps the SCHEDULE
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

  // Before the rethrow below: the chain has to survive a watch that keeps failing.
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
    // The retry re-runs the batch: the chain's claim is resumable, and the check
    // hands back the owed wakes again. Same contract as a per-watch tick that died
    // between its transition and its append.
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
 * row's own authority — including whether this was the window's boundary evaluation
 * — so this only re-shapes what it said.
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

/** POST the batch check, and refuse to guess at anything it didn't answer clearly. */
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
    // Deliberately a throw, not an empty batch: a batch that can't be read is a
    // failure to check the whole group, and the run must be retried rather than
    // quietly reschedule as if nothing was due.
    throw new Error(body?.error ?? `the batch check returned ${response.status}`);
  }

  return body ?? {};
}

// One connection pool per worker process for the watcher (separate from the
// agent's; ticks are their own runs).
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
 * The wake, as the agent receives it: one record on the chat's `in` stream
 * carrying `trigger: "action"`, which fires the agent's `onAction` hook (and
 * nothing else — actions are not turns). The append also ensures a live agent
 * run, so a wake reaches a chat whose run has long since idled out.
 *
 * `metadata` is the agent's `clientData`, rebuilt from the watch's own tenancy
 * snapshot. It deliberately carries NO delegated token: a wake narrates what the
 * check already established, it doesn't go reading.
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
    // The external ref a consented investigation is scoped by — the same
    // one a normal turn carries, so a follow-up turn revises that
    // investigation instead of opening a second one.
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
    // A chat born from the configuration card (0 LLM) has no session yet —
    // the card's confirmation is a direct JSONB append. The wake is the first
    // thing that needs one, so create it here (idempotent on externalId) and
    // retry once. Any other failure keeps the claim's retry semantics.
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
  // Everything a tick does is idempotent or guarded, and the failure modes are
  // transient (the check endpoint, the session append). Retry rather than lose
  // the wake; a retry after a transition delivers only.
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
  // Same reasoning as the per-watch tick: every write is guarded or keyed, so a
  // retry is safe and losing a wake is not. The reschedule happens before the
  // failures are rethrown, so retrying can never be the thing that ends the chain.
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
