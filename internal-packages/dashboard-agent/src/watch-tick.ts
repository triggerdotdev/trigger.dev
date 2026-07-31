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
} from "@internal/dashboard-agent-db";
import type { WatchCheckResult } from "@internal/dashboard-agent-contracts";
import { logger, sessions, task, tasks } from "@trigger.dev/sdk";
import type { WatchWakeAction } from "./dashboard-agent";

/**
 * The watcher — one invocation is one tick of one watch ("tell me when X
 * happens"). Triggered by the webapp when the watch is created, and by itself
 * on every reschedule until the condition resolves or the watch runs out of
 * time.
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
 *   only through a read-then-write on the transcript.
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
    status: "fired" | "expired";
    lastResult?: Record<string, unknown> | null;
  }): Promise<Watch | null>;
  /** Take the wake. Only the row this returns may be appended to the chat. */
  claimWatchDelivery(params: { id: string; staleBefore: Date }): Promise<Watch | null>;
  /** Hand the wake back after a failed append, so the retry can re-claim it. */
  releaseWatchDelivery(params: { id: string }): Promise<Watch | null>;
  markWatchDelivered(params: { id: string }): Promise<Watch | null>;
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
  | "fired"
  | "expired";

export type WatchTickResult = { outcome: WatchTickOutcome; tickCount?: number };

/** The check endpoint's answer, normalized. */
type CheckOutcome =
  | { kind: "result"; result: WatchCheckResult; facts?: Record<string, unknown> }
  // The row is already over and the webapp knows it: the tick exits without
  // transitioning or delivering.
  | { kind: "revoked"; code?: string }
  // The check itself couldn't run. Never true, never false.
  | { kind: "unavailable"; detail?: string };

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
    | { result?: WatchCheckResult; facts?: Record<string, unknown>; code?: string; error?: string }
    | undefined;

  if (!response.ok) {
    if (body?.code && REVOKED_CODES.has(body.code)) return { kind: "revoked", code: body.code };
    return {
      kind: "unavailable",
      detail: body?.error ?? `status ${response.status}${body?.code ? ` (${body.code})` : ""}`,
    };
  }

  if (!body?.result) return { kind: "unavailable", detail: "the check returned no result" };
  if (body.result === "unavailable") return { kind: "unavailable", detail: body.error };
  return { kind: "result", result: body.result, facts: body.facts };
}

/**
 * Tell the webapp the watch fired. The webapp owns the alert fan-out; this call
 * only says "it happened", and the row it reads is the authority on the rest.
 *
 * Same token as the check endpoint. No retry loop: the endpoint dedupes on the
 * watch, so a later tick or invocation retry can repeat it harmlessly, and losing
 * the alert is better than losing the wake.
 */
async function postFired(payload: WatchTickPayload): Promise<void> {
  const origin = payload.apiOrigin.replace(/\/$/, "");
  const response = await fetch(
    `${origin}/api/v1/dashboard-agent/watches/${encodeURIComponent(payload.watchId)}/fired`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${payload.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    }
  );

  if (!response.ok) {
    throw new Error(`the fired callback returned ${response.status}`);
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
    note: spec.note,
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
 */
async function deliverWake(deps: WatchDeliveryDeps, watch: Watch): Promise<boolean> {
  const now = deps.now?.() ?? new Date();
  const claimed = await deps.store.claimWatchDelivery({
    id: watch.id,
    staleBefore: new Date(now.getTime() - WATCH_DELIVERY_CLAIM_STALE_MS),
  });

  if (!claimed) {
    logger.info("dashboard-agent watch wake is already being delivered; skipping", {
      watchId: watch.id,
    });
    return false;
  }

  const facts = (claimed.lastResult ?? {}) as Record<string, unknown>;
  try {
    await deps.deliver({
      chatId: claimed.chatId,
      action: wakeAction(claimed, facts),
      watch: claimed,
    });
  } catch (error) {
    await deps.store.releaseWatchDelivery({ id: claimed.id });
    throw error;
  }
  await deps.store.markWatchDelivered({ id: claimed.id });

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
  status: "fired" | "expired",
  facts: Record<string, unknown>
): Promise<WatchTickResult> {
  const transitioned = await deps.store.transitionWatchCondition({
    id: watch.id,
    status,
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
  return { outcome: status === "fired" ? "fired" : "expired" };
}

/**
 * One tick. See the module comment for the invariants; the order of the branches
 * below IS the algorithm.
 */
export async function runWatchTick(
  payload: WatchTickPayload,
  deps: WatchTickDeps
): Promise<WatchTickResult> {
  const now = deps.now?.() ?? new Date();
  const watch = await deps.store.getWatch({ id: payload.watchId });

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
  if (payload.deliverOnly) {
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
    generation: payload.tick,
  });

  if (!claimed) {
    logger.info("dashboard-agent watch tick is stale; exiting", {
      watchId: watch.id,
      tick: payload.tick,
      tickCount: watch.tickCount,
    });
    return { outcome: "stale" };
  }

  // The claimed row is the authority from here on — it is the state this
  // invocation owns, re-read inside the same statement that claimed it.

  // The ROW is the authority on expiry, not the check. Past the deadline this is
  // the last check the watch gets, and the endpoint is told so.
  const final = claimed.expiresAt.getTime() <= now.getTime();
  const check = await postCheck(deps, payload, final);

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
      await scheduleNextTick(deps, payload, claimed);
      return { outcome: "unavailable", tickCount: payload.tick };
    }
    // The final check couldn't run, but the deadline still passed: the watch
    // expires, and the narration says the condition couldn't be verified.
    return resolveAndDeliver(
      deps,
      claimed,
      "expired",
      expiredFacts(claimed, { verified: false, reason: "unverified_at_expiry" })
    );
  }

  if (check.result === "satisfied") {
    return resolveAndDeliver(deps, claimed, "fired", firedFacts(check.facts));
  }

  if (check.result === "terminal_unsatisfied") {
    // Not a failure: it can never happen now. Stop checking and say so.
    return resolveAndDeliver(
      deps,
      claimed,
      "expired",
      expiredFacts(claimed, {
        verified: true,
        reason: "terminal_unsatisfied",
        facts: check.facts,
      })
    );
  }

  // Still pending. Past the deadline that's an expiry (the condition was checked
  // and hadn't happened); before it, tick again.
  if (final) {
    return resolveAndDeliver(
      deps,
      claimed,
      "expired",
      expiredFacts(claimed, { verified: true, reason: "not_met_by_expiry", facts: check.facts })
    );
  }

  await deps.store.recordWatchCheck({ id: claimed.id, lastResult: check.facts ?? {} });
  await scheduleNextTick(deps, payload, claimed);
  return { outcome: "pending", tickCount: payload.tick };
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
  await sessions.open(args.chatId).in.send({
    kind: "message",
    payload: {
      chatId: args.chatId,
      trigger: "action",
      action: args.action,
      metadata: {
        userId: args.watch.userId,
        organizationId: args.watch.organizationId,
        projectId: args.watch.projectId,
        environmentId: args.watch.environmentId,
      },
    },
  });
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
      store: {
        getWatch: (params) => getWatch(db, params),
        claimWatchTick: (params) => claimWatchTick(db, params),
        transitionWatchCondition: (params) => transitionWatchCondition(db, params),
        claimWatchDelivery: (params) => claimWatchDelivery(db, params),
        releaseWatchDelivery: (params) => releaseWatchDelivery(db, params),
        markWatchDelivered: (params) => markWatchDelivered(db, params),
        recordWatchCheck: (params) => recordWatchCheck(db, params),
      },
      fetch: (input, init) => fetch(input, init),
      deliver: appendWakeToSession,
      notifyFired: () => postFired(payload),
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
