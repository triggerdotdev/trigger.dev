import {
  createDashboardAgentDb,
  getWatch,
  isTerminalWatchStatus,
  markWatchDelivered,
  recordWatchTick,
  transitionWatchCondition,
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
 * - The terminal transition is atomic and one-way (`active` → fired/expired,
 *   delivery `pending`), and `markWatchDelivered` happens ONLY after the session
 *   append is acknowledged. Anything failing before that ack throws, so the
 *   platform retries the invocation; the retry finds terminal + pending and
 *   performs the delivery alone.
 */

/** What the webapp triggers on creation, and what a tick re-triggers on itself. */
export type WatchTickPayload = {
  watchId: string;
  /** The watch's own token, minted by the webapp. Authorizes the check endpoint. */
  token: string;
  apiOrigin: string;
};

/** The watch rows this task reads and writes, behind an interface so tests can fake it. */
export type WatchTickStore = {
  getWatch(params: { id: string }): Promise<Watch | null>;
  transitionWatchCondition(params: {
    id: string;
    status: "fired" | "expired";
    lastResult?: Record<string, unknown> | null;
  }): Promise<Watch | null>;
  markWatchDelivered(params: { id: string }): Promise<Watch | null>;
  recordWatchTick(params: {
    id: string;
    lastResult?: Record<string, unknown> | null;
    tickCount?: number;
  }): Promise<{ tickCount: number; lastCheckedAt: Date | null } | null>;
};

export type WatchTickDeps = {
  store: WatchTickStore;
  /** Injected so tests can assert the request the check endpoint receives. */
  fetch: typeof fetch;
  /** Append the wake to the chat's `in` stream. Must throw if the append fails. */
  deliver: (args: { chatId: string; action: WatchWakeAction; watch: Watch }) => Promise<void>;
  /** Trigger the next tick. */
  reschedule: (
    payload: WatchTickPayload,
    options: { delay: string; idempotencyKey: string }
  ) => Promise<unknown>;
  now?: () => Date;
};

/** What one tick did, for the run's output and the tests. */
export type WatchTickOutcome =
  | "missing"
  | "already_terminal"
  | "delivered_only"
  | "revoked"
  | "unavailable"
  | "pending"
  | "fired"
  | "expired";

export type WatchTickResult = { outcome: WatchTickOutcome; tickCount?: number };

/** The check endpoint's answer, normalized. */
type CheckOutcome =
  | { kind: "result"; result: WatchCheckResult; facts?: Record<string, unknown> }
  // The webapp already cancelled the watch (access revoked, or it's gone): the
  // tick exits without transitioning or delivering.
  | { kind: "revoked"; code?: string }
  // The check itself couldn't run. Never true, never false.
  | { kind: "unavailable"; detail?: string };

// Error codes that mean "this watch is over and the webapp knows it". Anything
// else non-2xx is a failed check, i.e. `unavailable`.
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
    // 401/403 without a code still means this token can't check any more —
    // treat it as over rather than retrying against a door that won't open.
    if (response.status === 401 || response.status === 403) {
      return { kind: "revoked", code: body?.code };
    }
    return { kind: "unavailable", detail: body?.error ?? `status ${response.status}` };
  }

  if (!body?.result) return { kind: "unavailable", detail: "the check returned no result" };
  if (body.result === "unavailable") return { kind: "unavailable", detail: body.error };
  return { kind: "result", result: body.result, facts: body.facts };
}

/** Facts for a watch that resolved on a check. */
function firedFacts(facts: Record<string, unknown> | undefined): Record<string, unknown> {
  return { verified: true, ...(facts ?? {}) };
}

/**
 * Facts for an expiry. When the FINAL check came back `unavailable` the watch
 * still expires — but the narration must not claim the thing didn't happen, so
 * the facts say the condition couldn't be verified at expiry and carry the last
 * observation we do have (`lastResult` from the last successful check).
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
      : { lastObservedAt: watch.lastCheckedAt?.toISOString(), lastObservation: watch.lastResult }),
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
 * Wake the chat, then mark the delivery. Idempotent: `markWatchDelivered` is
 * guarded on `pending`, and the action id is stable, so a retried invocation
 * that re-appends is deduped by the agent instead of narrating twice.
 *
 * Deliberately NOT try/caught — a failed append must fail the invocation so the
 * platform retries it, and the retry lands on terminal + pending and delivers
 * only.
 */
async function deliverWake(deps: WatchTickDeps, watch: Watch): Promise<void> {
  const facts = (watch.lastResult ?? {}) as Record<string, unknown>;
  await deps.deliver({ chatId: watch.chatId, action: wakeAction(watch, facts), watch });
  await deps.store.markWatchDelivered({ id: watch.id });
}

/**
 * Resolve the watch and wake the chat. The transition is the gate: only an
 * `active` row transitions, so a check that fires at the same moment the sweeper
 * expires the watch yields exactly one winner. The loser re-reads the row and
 * delivers whatever the winner decided, if that's still owed.
 */
async function resolveAndDeliver(
  deps: WatchTickDeps,
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
    // Someone else resolved it. Deliver only if that outcome is still undelivered.
    const current = await deps.store.getWatch({ id: watch.id });
    if (current && isTerminalWatchStatus(current.status) && current.deliveryStatus === "pending") {
      await deliverWake(deps, current);
      return { outcome: "delivered_only" };
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
    if (watch.deliveryStatus === "pending") {
      await deliverWake(deps, watch);
      return { outcome: "delivered_only" };
    }
    return { outcome: "already_terminal" };
  }

  // The ROW is the authority on expiry, not the check. Past the deadline this is
  // the last check the watch gets, and the endpoint is told so.
  const final = watch.expiresAt.getTime() <= now.getTime();
  const check = await postCheck(deps, payload, final);

  if (check.kind === "revoked") {
    logger.info("dashboard-agent watch check refused; exiting", {
      watchId: watch.id,
      code: check.code,
    });
    return { outcome: "revoked" };
  }

  if (check.kind === "unavailable") {
    if (!final) {
      // A failed tick: the counter moves, the result doesn't. Keep watching.
      const nextTick = watch.tickCount + 1;
      await deps.store.recordWatchTick({
        id: watch.id,
        tickCount: nextTick,
        lastResult: { checkFailed: true, detail: check.detail, previous: watch.lastResult },
      });
      await scheduleNextTick(deps, payload, watch, nextTick);
      return { outcome: "unavailable", tickCount: nextTick };
    }
    // The final check couldn't run, but the deadline still passed: the watch
    // expires, and the narration says the condition couldn't be verified.
    return resolveAndDeliver(
      deps,
      watch,
      "expired",
      expiredFacts(watch, { verified: false, reason: "unverified_at_expiry" })
    );
  }

  if (check.result === "satisfied") {
    return resolveAndDeliver(deps, watch, "fired", firedFacts(check.facts));
  }

  if (check.result === "terminal_unsatisfied") {
    // Not a failure: it can never happen now. Stop checking and say so.
    return resolveAndDeliver(
      deps,
      watch,
      "expired",
      expiredFacts(watch, {
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
      watch,
      "expired",
      expiredFacts(watch, { verified: true, reason: "not_met_by_expiry", facts: check.facts })
    );
  }

  const nextTick = watch.tickCount + 1;
  await deps.store.recordWatchTick({
    id: watch.id,
    tickCount: nextTick,
    lastResult: check.facts ?? {},
  });
  await scheduleNextTick(deps, payload, watch, nextTick);
  return { outcome: "pending", tickCount: nextTick };
}

/**
 * Trigger the next tick, `checkEveryMinutes` out.
 *
 * The idempotency key is `watch:{id}:tick:{n}` where `n` comes from the row we
 * just read (`tickCount + 1`) — NOT from an incremented counter. That pairing
 * with the explicit `recordWatchTick({ tickCount: n })` above is what makes a
 * retried invocation converge instead of forking the chain: the retry either
 * computes the same `n` (and the key collapses the duplicate trigger) or reads
 * the already-advanced row and schedules the single next one.
 */
async function scheduleNextTick(
  deps: WatchTickDeps,
  payload: WatchTickPayload,
  watch: Watch,
  tickCount: number
): Promise<void> {
  const spec = watch.spec as PersistedWatchSpec;
  await deps.reschedule(payload, {
    delay: `${spec.checkEveryMinutes}m`,
    idempotencyKey: `watch:${watch.id}:tick:${tickCount}`,
  });
}

// One connection pool per worker process for the watcher (separate from the
// agent's; ticks are their own runs).
let dbClient: DashboardAgentDbClient | undefined;
function getWatchDb(): DashboardAgentDbClient {
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
async function appendWakeToSession(args: {
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
        transitionWatchCondition: (params) => transitionWatchCondition(db, params),
        markWatchDelivered: (params) => markWatchDelivered(db, params),
        recordWatchTick: (params) => recordWatchTick(db, params),
      },
      fetch: (input, init) => fetch(input, init),
      deliver: appendWakeToSession,
      reschedule: (next, options) =>
        tasks.trigger<typeof watchTick>("dashboard-agent-watch", next, options),
    });

    logger.info("dashboard-agent watch ticked", {
      watchId: payload.watchId,
      outcome: result.outcome,
      tickCount: result.tickCount,
    });

    return result;
  },
});
