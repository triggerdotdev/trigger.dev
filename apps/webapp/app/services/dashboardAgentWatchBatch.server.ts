/**
 * The batch check — every due watch of one (environment, cadence) group, evaluated
 * in ONE pass.
 *
 * This is where the cost of the feature is decided. A watch used to get its own tick
 * run, and each of those separately authorized the environment, loaded whatever its
 * condition needed (the health report above all) and evaluated exactly one
 * condition. Ten watches in an environment meant ten authorizations and ten report
 * loads for one logical check. Here the group is the unit: the environment is
 * authorized once per distinct initiating user, the shared readers are built once,
 * and every due condition is evaluated against them.
 *
 * What did NOT change is the part that decides what the user is told. This route
 * answers with the same per-watch verdict the single check endpoint answers with, and
 * the agent's tick task runs the same lifecycle over it — the generation claim, the
 * resolution model, the boundary evaluation, the guarded terminal transition, the
 * fenced wake. Batching moved the reads, not the semantics.
 *
 * The security model is the single check endpoint's, applied per row:
 *
 *  1. the chain TOKEN only names an (environment, cadence) group, and a token for a
 *     different group is refused,
 *  2. the ROW is the authority on lifecycle — its status, its deadline, and its
 *     immutable project/environment/user snapshot. A row whose snapshot doesn't name
 *     the group's environment is never even looked at,
 *  3. every watch's own initiating USER is re-authorized against that row's own
 *     snapshot before any environment data is read, and a revoked user gets the
 *     watch cancelled here. Sharing readers across a group never shares access:
 *     authorization is memoized per user, not skipped.
 *
 * Like the single endpoint, this does NOT transition watches and does NOT advance any
 * tick counter. It records what each check observed and reports the verdicts; the
 * agent's task owns the fire/expire transition and the delivery, so exactly one
 * component decides when a user gets told.
 */

import {
  cancelWatch,
  claimWatchBatchTick,
  listActiveWatchesForBatch,
  listWatchesAwaitingDeliveryForBatch,
  recordWatchCheck,
  stopWatchBatch,
  WATCH_DELIVERY_CLAIM_STALE_MS,
  type Watch,
} from "@internal/dashboard-agent-db";
import type { WatchBatchCheckEntry, WatchBatchCheckResponse } from "@internal/dashboard-agent";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { logger } from "~/services/logger.server";
import {
  checkWatch,
  previousCheckFacts,
  type WatchCheckDeps,
} from "~/services/dashboardAgentWatchChecks";
import { watchCheckDeps } from "~/services/dashboardAgentWatchChecks.server";
import {
  authorizeWatchEnvironment,
  type WatchAuthorization,
} from "~/services/dashboardAgentWatches.server";
import {
  mintDashboardAgentWatchToken,
  WATCH_TOKEN_GRACE_MS,
} from "~/services/dashboardAgentWatchToken.server";

/**
 * How much early a watch may be checked and still count as due. Without it a tick
 * that lands a few seconds before the cadence elapsed would skip the watch and defer
 * it a whole cadence — the delay compounds, and a one-minute watch stops being a
 * one-minute watch. Capped at half a cadence so it can never double a group's rate.
 */
function dueSlackMs(cadenceMinutes: number): number {
  return Math.min(30_000, (cadenceMinutes * 60_000) / 2);
}

/**
 * How many conditions are evaluated at once. A small constant: it exists so one slow
 * condition can't serialize the group, not to fan out — the shared reads already
 * happened, and what is left per watch is one or two narrow queries.
 */
const EVALUATION_CONCURRENCY = 8;

export type WatchBatchCheckDeps = {
  now?: () => Date;
  /** The group's active watches. */
  listActive?: (params: { environmentId: string; cadenceMinutes: number }) => Promise<Watch[]>;
  /** The group's resolved watches whose wake is still owed. */
  listOwed?: (params: {
    environmentId: string;
    cadenceMinutes: number;
    claimStaleBefore: Date;
  }) => Promise<Watch[]>;
  /** Re-authorization of one watch's initiating user. */
  authorize?: (watch: Watch) => Promise<WatchAuthorization>;
  /** The environment readers the conditions run against. */
  checkDeps?: (environment: AuthenticatedEnvironment, now: Date) => WatchCheckDeps;
  /** The per-watch token the fired / investigate callbacks are made with. */
  mintToken?: (watch: Watch) => Promise<string>;
  concurrency?: number;
};

/**
 * Run one batch tick's checks.
 *
 * The claim comes first and decides whether this run owns the tick at all: a
 * duplicate whose successor already ran, or a zombie from before the chain was
 * re-armed, claims nothing and is told it is stale. That is what keeps the SCHEDULE
 * single-file — it is not what keeps a watch from firing twice. Two runs that both
 * pass the claim still meet the guarded terminal transition and the fenced delivery
 * claim on every watch they touch, and those pick one winner each.
 */
export async function runWatchBatchCheck(
  params: { environmentId: string; cadenceMinutes: number; epoch: number; tick: number },
  deps: WatchBatchCheckDeps = {}
): Promise<WatchBatchCheckResponse> {
  const now = deps.now?.() ?? new Date();
  const listActive =
    deps.listActive ?? ((args) => listActiveWatchesForBatch(dashboardAgentDb, args));
  const listOwed =
    deps.listOwed ?? ((args) => listWatchesAwaitingDeliveryForBatch(dashboardAgentDb, args));
  const mintToken =
    deps.mintToken ??
    ((watch: Watch) =>
      mintDashboardAgentWatchToken({ watchId: watch.id, expiresAt: watch.expiresAt }));

  const claimed = await claimWatchBatchTick(dashboardAgentDb, {
    environmentId: params.environmentId,
    cadenceMinutes: params.cadenceMinutes,
    epoch: params.epoch,
    // The tick a run carries IS the generation it owns, same as a watch's own.
    generation: params.tick,
  });
  if (!claimed) {
    logger.debug("Dashboard agent watch batch: the tick is stale", params);
    return { stale: true };
  }

  const active = await listActive({
    environmentId: params.environmentId,
    cadenceMinutes: params.cadenceMinutes,
  });

  // No active watches left: the group has nothing to poll, so the chain stops here
  // rather than ticking an empty environment forever. Fenced on the epoch, so this
  // can only ever end the chain this run belongs to. A watch created a moment later
  // simply arms a fresh one.
  if (active.length === 0) {
    await stopWatchBatch(dashboardAgentDb, {
      environmentId: params.environmentId,
      cadenceMinutes: params.cadenceMinutes,
      epoch: params.epoch,
    });
  }

  const due = active.filter((watch) => isDue(watch, params.cadenceMinutes, now));
  const evaluated = await evaluateGroup(due, params, { ...deps, now: () => now }, mintToken);

  // Wakes this group still owes — a delivery that failed, or a deliverer that died
  // mid-append. The group's own tick recovers them, which is what preserves the
  // retry-in-seconds a per-watch tick had: the run that failed one watch's append is
  // retried, and finds it here.
  const owed = await listOwed({
    environmentId: params.environmentId,
    cadenceMinutes: params.cadenceMinutes,
    claimStaleBefore: new Date(now.getTime() - WATCH_DELIVERY_CLAIM_STALE_MS),
  });

  const deliveries = await Promise.all(
    owed.map(async (watch) => ({
      watchId: watch.id,
      token: await mintToken(watch),
      tick: 0,
      deliverOnly: true as const,
    }))
  );

  return {
    watches: [...evaluated, ...deliveries],
    continues: active.length > 0,
  };
}

/**
 * Is this watch due on this tick?
 *
 * Two ways to be due, and the second one is §7.4's boundary rule: a watch whose
 * window closes before the next tick comes round is checked NOW, because its final
 * evaluation is a real evaluation and it must not be missed. Everything else is due
 * once its cadence has elapsed since the last observation.
 *
 * A watch that is already far past its deadline is deliberately NOT due: past the
 * token grace the expiry sweep owns it, exactly as on the single check endpoint.
 */
export function isDue(watch: Watch, cadenceMinutes: number, now: Date): boolean {
  const nowMs = now.getTime();
  const cadenceMs = cadenceMinutes * 60_000;

  if (nowMs > watch.expiresAt.getTime() + WATCH_TOKEN_GRACE_MS) return false;
  if (watch.expiresAt.getTime() <= nowMs + cadenceMs) return true;

  const lastChecked = watch.lastCheckedAt?.getTime();
  return lastChecked === undefined || lastChecked <= nowMs - cadenceMs + dueSlackMs(cadenceMinutes);
}

/**
 * Evaluate the due watches against ONE set of readers.
 *
 * The two memos are the whole economy of the batch. Authorization is cached per
 * (user, org, project) — the tenancy triple a row's snapshot has to name — so ten
 * watches one person created cost one authorization while two people's watches still
 * cost two. The readers are built once for the environment, so the health report is
 * loaded once for the group instead of once per watch.
 *
 * Bounded concurrency, and each watch inside its own try: a condition that throws or
 * a user who lost access is that watch's answer alone, and the rest of the group is
 * still evaluated.
 */
async function evaluateGroup(
  due: Watch[],
  params: { environmentId: string; cadenceMinutes: number },
  deps: WatchBatchCheckDeps,
  mintToken: (watch: Watch) => Promise<string>
): Promise<WatchBatchCheckEntry[]> {
  if (due.length === 0) return [];

  const now = deps.now?.() ?? new Date();
  const authorize = deps.authorize ?? defaultAuthorize;
  const buildCheckDeps = deps.checkDeps ?? watchCheckDeps;

  const authorizations = new Map<string, Promise<WatchAuthorization>>();
  const authorizeOnce = (watch: Watch) => {
    const key = `${watch.userId}:${watch.organizationId}:${watch.projectId}`;
    const cached = authorizations.get(key);
    if (cached) return cached;
    const pending = authorize(watch);
    authorizations.set(key, pending);
    return pending;
  };

  // Built from the first authorization that passes, then shared — every row in the
  // group names the same environment, so the readers are the same whoever proved
  // access to it, and `shareReads` is what turns that into one read per source.
  let readers: WatchCheckDeps | undefined;

  const evaluateOne = async (
    watch: Watch,
    base: { watchId: string; token: string; tick: number }
  ): Promise<WatchBatchCheckEntry> => {
    const authorization = await authorizeOnce(watch);
    if (!authorization.ok) {
      // Cancel before returning, and before anything is read: a watch must not
      // outlive the access it was created with. Never narrated.
      await cancelWatch(dashboardAgentDb, { id: watch.id, reason: "access_revoked" });
      return { ...base, code: "access_revoked", error: "Access to this environment was revoked" };
    }

    readers ??= shareReads(buildCheckDeps(authorization.environment, now));

    const since = watch.spec.since ? new Date(watch.spec.since) : watch.createdAt;
    const final = watch.expiresAt.getTime() <= now.getTime();
    const outcome = await checkWatch(
      watch.spec,
      readers,
      // `previous` is the stateful seam, off the row we already hold — a check that
      // couldn't read anything freezes a streak instead of resetting it.
      { now, since, previous: previousCheckFacts(watch.lastResult) },
      (error) =>
        logger.error("Dashboard agent watch batch: a check failed", {
          error,
          watchId: watch.id,
          environmentId: params.environmentId,
        })
    );

    // Recorded even on the final evaluation: it stamps `lastCheckedAt` and parks the
    // facts the notification reads. Guarded on `active`, never touches `tickCount`.
    await recordWatchCheck(dashboardAgentDb, {
      id: watch.id,
      lastResult: {
        result: outcome.result,
        facts: outcome.facts,
        observed: outcome.observed,
        final,
      },
    });

    return { ...base, result: outcome.result, facts: outcome.facts, observed: outcome.observed };
  };

  return mapWithConcurrency(due, deps.concurrency ?? EVALUATION_CONCURRENCY, async (watch) => {
    // Minted outside the isolation boundary: it is a pure signing call, so a failure
    // here is the whole batch's problem rather than one watch's, and the catch below
    // needs a token it can't fail to have.
    const base = { watchId: watch.id, token: await mintToken(watch), tick: watch.tickCount + 1 };
    try {
      return await evaluateOne(watch, base);
    } catch (error) {
      logger.error("Dashboard agent watch batch: a watch couldn't be evaluated", {
        watchId: watch.id,
        environmentId: params.environmentId,
        error,
      });
      // `unavailable`, which is never read as true and never as false: the watch
      // keeps its state and is checked again next tick.
      return { ...base, result: "unavailable" as const, error: (error as Error).message };
    }
  });
}

/**
 * Wrap a batch's readers so each distinct read happens ONCE.
 *
 * Building the readers once is not enough on its own: `readHealth()` is a function,
 * and ten watches calling it is ten report loads. Inside one tick every reader's
 * answer is a pure function of its arguments — `now` is fixed for the batch, and the
 * environment doesn't change under it — so the answer is cached on those arguments and
 * the group shares it. The health report is the read this exists for; the queue and
 * recurrence reads benefit whenever two watches watch the same thing.
 *
 * A failed read is cached too. A reader that threw would throw for every watch in the
 * group anyway (they share the source), and each of them still gets its own
 * `unavailable` out of it — caching only stops the group from hammering a source that
 * is already down.
 */
function shareReads(readers: WatchCheckDeps): WatchCheckDeps {
  const cache = new Map<string, Promise<unknown>>();
  const once = <A extends unknown[], R>(name: string, read: (...args: A) => Promise<R>) => {
    return (...args: A): Promise<R> => {
      const key = `${name}:${JSON.stringify(args)}`;
      const cached = cache.get(key);
      if (cached) return cached as Promise<R>;
      const pending = read(...args);
      cache.set(key, pending);
      return pending;
    };
  };

  return {
    readRun: once("readRun", readers.readRun),
    queueExists: once("queueExists", readers.queueExists),
    readQueueDepth: once("readQueueDepth", readers.readQueueDepth),
    readQueueOldestAge: once("readQueueOldestAge", readers.readQueueOldestAge),
    readErrorRecurrence: once("readErrorRecurrence", readers.readErrorRecurrence),
    readHealth: once("readHealth", readers.readHealth),
  };
}

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

function defaultAuthorize(watch: Watch): Promise<WatchAuthorization> {
  return authorizeWatchEnvironment({
    userId: watch.userId,
    organizationId: watch.organizationId,
    projectId: watch.projectId,
    environmentId: watch.environmentId,
  });
}
