/**
 * The batch check: every due watch of one (environment, cadence) group in one pass. Each row is
 * the authority on its own snapshot, and each initiating user is re-authorized before any read.
 */

import {
  cancelWatch,
  claimWatchBatchTick,
  listActiveWatchesForBatch,
  listWatchesAwaitingDeliveryForBatch,
  recordWatchAttempt,
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
 * How early a watch may be checked and still count as due, so a tick landing seconds
 * early doesn't defer it a whole cadence. Capped at half a cadence.
 */
function dueSlackMs(cadenceMinutes: number): number {
  return Math.min(30_000, (cadenceMinutes * 60_000) / 2);
}

/** Small on purpose: it stops one slow condition serializing the group, not to fan out. */
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
 * Run one batch tick's checks. The claim decides whether this run owns the tick and keeps the
 * schedule single-file; the guarded transition and fenced delivery claim stop a double fire.
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
    // The tick a run carries is the generation it owns.
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

  const due = active.filter((watch) => isDue(watch, params.cadenceMinutes, now));
  const evaluated = await evaluateGroup(due, params, { ...deps, now: () => now }, mintToken);

  // Wakes this group still owes. Read after the evaluation, so a wake this tick resolved
  // and failed to deliver is already in it.
  const owed = await listOwed({
    environmentId: params.environmentId,
    cadenceMinutes: params.cadenceMinutes,
    claimStaleBefore: new Date(now.getTime() - WATCH_DELIVERY_CLAIM_STALE_MS),
  });

  const deliveries = await Promise.all(
    owed.map(async (watch) => ({
      watchId: watch.id,
      token: await mintToken(watch),
      // A delivery decides nothing, so it claims no generation.
      tick: 0,
      deliverOnly: true as const,
    }))
  );

  // The chain only stops with nothing to poll and nothing owed: stopping while a wake is
  // owed strands it. Fenced on the epoch, so it can only end this run's own chain.
  const continues = active.length > 0 || owed.length > 0;
  if (!continues) {
    await stopWatchBatch(dashboardAgentDb, {
      environmentId: params.environmentId,
      cadenceMinutes: params.cadenceMinutes,
      epoch: params.epoch,
    });
  }

  return { watches: [...evaluated, ...deliveries], continues };
}

/**
 * A watch whose window closes before the next tick is due now, so its final evaluation is
 * never missed. A watch past the token grace is never due: the expiry sweep owns it.
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
 * Evaluate the due watches against one set of readers. Authorization is cached per (user, org,
 * project); each watch runs in its own try, so a failure is that watch's answer alone.
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

  // Built from the first authorization that passes, then shared: every row in the group
  // names the same environment.
  let readers: WatchCheckDeps | undefined;

  const evaluateOne = async (
    watch: Watch,
    base: { watchId: string; token: string; tick: number }
  ): Promise<WatchBatchCheckEntry> => {
    const authorization = await authorizeOnce(watch);
    if (!authorization.ok) {
      // Cancel before anything is read: a watch must not outlive its creator's access.
      await cancelWatch(dashboardAgentDb, { id: watch.id, reason: "access_revoked" });
      return { ...base, code: "access_revoked", error: "Access to this environment was revoked" };
    }

    readers ??= shareReads(buildCheckDeps(authorization.environment, now));

    const since = watch.spec.since ? new Date(watch.spec.since) : watch.createdAt;
    const final = watch.expiresAt.getTime() <= now.getTime();
    const outcome = await checkWatch(
      watch.spec,
      readers,
      // A check that couldn't read anything freezes a streak instead of resetting it.
      { now, since, previous: previousCheckFacts(watch.lastResult) },
      (error) =>
        logger.error("Dashboard agent watch batch: a check failed", {
          error,
          watchId: watch.id,
          environmentId: params.environmentId,
        })
    );

    // Only a real evaluation is recorded, final or not: `unavailable` means nothing was read,
    // so writing it would move `lastCheckedAt` and overwrite the facts a streak lives in.
    // Guarded on `active`, and never touches `tickCount`.
    if (outcome.result !== "unavailable") {
      await recordWatchCheck(dashboardAgentDb, {
        id: watch.id,
        lastResult: {
          result: outcome.result,
          facts: outcome.facts,
          observed: outcome.observed,
          final,
        },
      });
    } else {
      // Looked at, not checked: this rotates the watch out of its group's head without
      // touching its dueness or the facts its streak lives in.
      await recordWatchAttempt(dashboardAgentDb, { id: watch.id });
    }

    return { ...base, result: outcome.result, facts: outcome.facts, observed: outcome.observed };
  };

  return mapWithConcurrency(due, deps.concurrency ?? EVALUATION_CONCURRENCY, async (watch) => {
    // Minted outside the try, because the catch below needs a token it can't fail to have.
    const base = { watchId: watch.id, token: await mintToken(watch), tick: watch.tickCount + 1 };
    try {
      return await evaluateOne(watch, base);
    } catch (error) {
      logger.error("Dashboard agent watch batch: a watch couldn't be evaluated", {
        watchId: watch.id,
        environmentId: params.environmentId,
        error,
      });
      // `unavailable` is never read as true or false: the watch keeps its state. Still a
      // look, so the fairness key moves even when nothing else does.
      await recordWatchAttempt(dashboardAgentDb, { id: watch.id }).catch(() => {});
      return { ...base, result: "unavailable" as const, error: (error as Error).message };
    }
  });
}

/**
 * Wrap a batch's readers so each distinct read happens once. `now` is fixed for the batch, so
 * a reader's answer is a pure function of its arguments. Failed reads are cached too.
 *
 * Exported for the expiry sweep, which finalizes the same rows against the same readers.
 */
export function shareReads(readers: WatchCheckDeps): WatchCheckDeps {
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
export async function mapWithConcurrency<T, R>(
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
