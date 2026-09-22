import type { TaskQueue, User } from "@trigger.dev/database";
import { errAsync, fromPromise, okAsync, type ResultAsync } from "neverthrow";
import { Prisma, type PrismaClientOrTransaction } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  removeQueueConcurrencyLimits,
  removeQueueTotalConcurrencyLimits,
  updateQueueConcurrencyLimits,
  updateQueueTotalConcurrencyLimits,
} from "../runQueue.server";
import { engine } from "../runEngine.server";
import { logger } from "~/services/logger.server";
import { sanitizeQueueName } from "~/models/taskQueue.server";
import { anonymousConcurrencyLimitQueueName } from "./concurrencyLimitNames.server";

export type ConcurrencyLimitsSystemOptions = {
  db: PrismaClientOrTransaction;
  reader: PrismaClientOrTransaction;
};

/** Queue rows that back named concurrency limits live under this reserved prefix. */
const LIMIT_QUEUE_PREFIX = "limit/";

const LIMIT_NAME_PATTERN = /^[a-zA-Z0-9_/-]{1,122}$/;

type ConcurrencyLimitBoundValue = {
  current: number | null;
  base: number | null;
  override: number | null;
  overriddenAt: Date | null;
};

type ConcurrencyLimitItem = {
  id: string;
  name: string;
  perKey: ConcurrencyLimitBoundValue;
  total: ConcurrencyLimitBoundValue;
  running: number;
  queued: number;
  paused: boolean;
};

/**
 * An override changes only the given bounds; each bound is a non-negative integer
 * (zero blocks every run holding the limit, which is how a limit is paused).
 */
type ConcurrencyLimitOverrideInput = {
  perKey?: number;
  total?: number;
};

export class ConcurrencyLimitsSystem {
  constructor(private readonly options: ConcurrencyLimitsSystemOptions) {}

  private get db() {
    return this.options.db;
  }

  private get reader() {
    return this.options.reader;
  }

  get limits() {
    return {
      list: (environment: AuthenticatedEnvironment, page: { page: number; perPage: number }) => {
        return fromPromise(
          this.reader.taskQueue.findMany({
            where: limitRowsWhere(environment),
            orderBy: { name: "asc" },
            skip: (page.page - 1) * page.perPage,
            take: page.perPage,
          }),
          (error) => ({ type: "other" as const, cause: error })
        ).andThen((rows) =>
          fromPromise(toLimitItems(environment, rows), (error) => ({
            type: "other" as const,
            cause: error,
          }))
        );
      },
      totalCount: (environment: AuthenticatedEnvironment) => {
        return fromPromise(
          this.reader.taskQueue.count({ where: limitRowsWhere(environment) }),
          (error) => ({ type: "other" as const, cause: error })
        );
      },
      retrieve: (environment: AuthenticatedEnvironment, name: string) => {
        return findLimitByName(this.db, environment, name).andThen((row) =>
          fromPromise(toLimitItems(environment, [row]), (error) => ({
            type: "other" as const,
            cause: error,
          })).map((items) => items[0])
        );
      },
      override: (
        environment: AuthenticatedEnvironment,
        name: string,
        override: ConcurrencyLimitOverrideInput,
        overriddenBy?: User
      ) => {
        if (override.perKey === undefined && override.total === undefined) {
          return errAsync({
            type: "invalid_override" as const,
            message: "Provide at least one of `perKey` or `total`",
          });
        }

        for (const [field, value] of Object.entries(override)) {
          if (value === undefined) continue;
          if (!Number.isInteger(value) || value < 0 || value > 100000) {
            return errAsync({
              type: "invalid_override" as const,
              message: `\`${field}\` must be an integer between 0 and 100000`,
            });
          }
          if (value > environment.maximumConcurrencyLimit) {
            return errAsync({
              type: "invalid_override" as const,
              message: `\`${field}\` (${value}) cannot exceed the environment limit (${environment.maximumConcurrencyLimit})`,
            });
          }
        }

        return findLimitByName(this.db, environment, name)
          .andThen((row) => applyLimitOverride(this.db, row, override, overriddenBy))
          .andThen((row) =>
            syncLimitToEngine(environment, row)
              .andThen(() =>
                compensateEngineFromFreshRow(this.db, environment, row.id, {
                  alreadySynced: {
                    perKey: row.concurrencyLimit,
                    total: row.totalConcurrencyLimit,
                    paused: row.paused,
                  },
                })
                  .orElse(() => okAsync(undefined))
                  .map(() => row)
              )
              .orElse((error) =>
                compensateEngineFromFreshRow(this.db, environment, row.id)
                  .orElse(() => okAsync(undefined))
                  .andThen(() => errAsync(error))
              )
          )
          .andThen((row) =>
            fromPromise(toLimitItems(environment, [row]), (error) => ({
              type: "other" as const,
              cause: error,
            })).map((items) => items[0])
          );
      },
      pause: (environment: AuthenticatedEnvironment, name: string) => {
        return this.setLimitPaused(environment, name, true);
      },
      resume: (environment: AuthenticatedEnvironment, name: string) => {
        return this.setLimitPaused(environment, name, false);
      },
      reset: (environment: AuthenticatedEnvironment, name: string) => {
        return findLimitByName(this.db, environment, name)
          .andThen((row) =>
            syncResetToEngine(environment, row).orElse((error) =>
              error.type === "limit_not_overridden"
                ? errAsync(error)
                : compensateEngineFromFreshRow(this.db, environment, row.id)
                    .orElse(() => okAsync(undefined))
                    .andThen(() => errAsync(error))
            )
          )
          .andThen((row) =>
            resetLimitOverrides(this.db, row).orElse((error) =>
              compensateEngineFromFreshRow(this.db, environment, row.id)
                .orElse(() => okAsync(undefined))
                .andThen(() => errAsync(error))
            )
          )
          .andThen((row) =>
            fromPromise(toLimitItems(environment, [row]), (error) => ({
              type: "other" as const,
              cause: error,
            })).map((items) => items[0])
          );
      },
    };
  }

  /**
   * Pause blocks admission without touching the configured bounds: the row's
   * `paused` flag flips, then the per-key engine key syncs through the
   * pause-aware write (0 while paused, the stored value — or a removal when
   * boundless — on resume). The total key never changes: pause is entirely the
   * per-key 0, which already blocks every key pool and the keyless pool.
   */
  private setLimitPaused(environment: AuthenticatedEnvironment, name: string, paused: boolean) {
    return findLimitByName(this.db, environment, name)
      .andThen((row) => guardedLimitUpdate(this.db, row, { paused }))
      .andThen((row) =>
        syncLimitPauseToEngine(environment, row)
          .andThen(() =>
            compensateEngineFromFreshRow(this.db, environment, row.id, {
              alreadySynced: {
                perKey: row.concurrencyLimit,
                total: row.totalConcurrencyLimit,
                paused: row.paused,
              },
            })
              .orElse(() => okAsync(undefined))
              .map(() => row)
          )
          .orElse((error) =>
            compensateEngineFromFreshRow(this.db, environment, row.id)
              .orElse(() => okAsync(undefined))
              .andThen(() => errAsync(error))
          )
      )
      .andThen((row) =>
        fromPromise(toLimitItems(environment, [row]), (error) => ({
          type: "other" as const,
          cause: error,
        })).map((items) => items[0])
      );
  }
}

function concurrencyLimitDisplayId(row: Pick<TaskQueue, "friendlyId">): string {
  return `climit_${row.friendlyId.replace(/^queue_/, "")}`;
}

function concurrencyLimitNameFromRow(row: Pick<TaskQueue, "name">): string {
  return row.name.startsWith(LIMIT_QUEUE_PREFIX)
    ? row.name.slice(LIMIT_QUEUE_PREFIX.length)
    : row.name;
}

/**
 * Limits live in two places: named and shared-queue inline limits are LIMIT-role
 * rows under the `limit/` prefix, while an inline limit on a task's own default
 * queue compiles onto that V2 QUEUE row (the design's zero-gate-cost case). Its
 * derived `task/<id>` name resolves here too, so every declared limit is
 * retrievable and overridable through this one surface. V1 queue rows never
 * match: their limit is queue surface, managed through the queues API. Only the
 * anonymous `limit/task/` namespace requires bounds — a boundless row there is
 * retired (its inline limit moved onto the task's own queue) and must fall
 * through to the live queue row — while a boundless NAMED limit is a real,
 * deliberately uncapped row (referenced without a declaration) that stays
 * visible and cappable.
 */
function limitRowsWhere(environment: AuthenticatedEnvironment) {
  return {
    runtimeEnvironmentId: environment.id,
    OR: [
      {
        role: "LIMIT" as const,
        OR: [
          { name: { not: { startsWith: `${LIMIT_QUEUE_PREFIX}task/` } } },
          { concurrencyLimit: { not: null } },
          { totalConcurrencyLimit: { not: null } },
        ],
      },
      {
        role: "QUEUE" as const,
        concurrencyVersion: "V2" as const,
        OR: [{ concurrencyLimit: { not: null } }, { totalConcurrencyLimit: { not: null } }],
      },
    ],
  };
}

function findLimitByName(
  db: PrismaClientOrTransaction,
  environment: AuthenticatedEnvironment,
  name: string
) {
  /**
   * Anonymous task limits are addressed as task/<task-id>, but task ids are not
   * charset-restricted, so their row names are derived (sanitized, hashed when
   * sanitization is lossy or the name overflows). Derive with the same function
   * materialization uses so every documented name resolves; declared names keep the
   * strict pattern, under which the public name IS the row suffix.
   */
  const isTaskName = name.startsWith("task/");
  let limitRowName: string;
  let queueRowName: string | null = null;
  if (isTaskName) {
    const taskId = name.slice("task/".length);
    if (taskId.length === 0) {
      return errAsync({ type: "limit_not_found" as const });
    }
    limitRowName = anonymousConcurrencyLimitQueueName(taskId);
    queueRowName = sanitizeQueueName(name);
  } else {
    if (!LIMIT_NAME_PATTERN.test(name)) {
      return errAsync({ type: "limit_not_found" as const });
    }
    limitRowName = `${LIMIT_QUEUE_PREFIX}${name}`;
  }

  return fromPromise(
    db.taskQueue.findFirst({
      where: {
        runtimeEnvironmentId: environment.id,
        name: limitRowName,
        role: "LIMIT",
        ...(isTaskName
          ? {
              OR: [{ concurrencyLimit: { not: null } }, { totalConcurrencyLimit: { not: null } }],
            }
          : {}),
      },
    }),
    (error) => ({ type: "other" as const, cause: error })
  ).andThen((row) => {
    if (row) {
      return okAsync(row);
    }
    if (queueRowName === null) {
      return errAsync({ type: "limit_not_found" as const });
    }
    return fromPromise(
      db.taskQueue.findFirst({
        where: {
          runtimeEnvironmentId: environment.id,
          name: queueRowName,
          role: "QUEUE",
          concurrencyVersion: "V2",
        },
      }),
      (error) => ({ type: "other" as const, cause: error })
    ).andThen((queueRow) => {
      if (!queueRow) {
        return errAsync({ type: "limit_not_found" as const });
      }
      return okAsync(queueRow);
    });
  });
}

/**
 * LIMIT rows read the gate machinery (group set + per-gate queued counter); a
 * default-queue inline limit is its home queue, so the queue's own concurrency
 * and length ARE the runs holding and waiting on the limit.
 */
async function toLimitItems(
  environment: AuthenticatedEnvironment,
  rows: TaskQueue[]
): Promise<ConcurrencyLimitItem[]> {
  const limitNames = rows.filter((row) => row.role === "LIMIT").map((row) => row.name);
  const queueNames = rows.filter((row) => row.role === "QUEUE").map((row) => row.name);
  const [gateRunning, gateQueued, queueRunning, queueQueued] = await Promise.all([
    engine.totalConcurrencyOfQueues(environment, limitNames),
    engine.gateQueuedCountOfQueues(environment, limitNames),
    queueNames.length > 0
      ? engine.currentConcurrencyOfQueues(environment, queueNames)
      : Promise.resolve({} as Record<string, number>),
    queueNames.length > 0
      ? engine.lengthOfQueues(environment, queueNames)
      : Promise.resolve({} as Record<string, number>),
  ]);
  const running = { ...queueRunning, ...gateRunning };
  const queued = { ...queueQueued, ...gateQueued };

  return rows.map((row) => ({
    id: concurrencyLimitDisplayId(row),
    name: concurrencyLimitNameFromRow(row),
    perKey: toBound(
      row.concurrencyLimit,
      row.concurrencyLimitBase,
      row.concurrencyLimitOverriddenAt,
      environment.maximumConcurrencyLimit
    ),
    total: toBound(
      row.totalConcurrencyLimit,
      row.totalConcurrencyLimitBase,
      row.totalConcurrencyLimitOverriddenAt,
      environment.maximumConcurrencyLimit
    ),
    running: running[row.name] ?? 0,
    queued: queued[row.name] ?? 0,
    paused: row.paused,
  }));
}

/**
 * Rows store bounds exactly as declared, preserving intent when the environment limit
 * later changes; the engine admits at most the environment limit regardless. `current`
 * is documented as the value enforced right now, so it clamps here while `base` and
 * `override` stay raw.
 */
function toBound(
  stored: number | null,
  base: number | null,
  overriddenAt: Date | null,
  environmentMaximum: number
): ConcurrencyLimitBoundValue {
  const overridden = overriddenAt !== null;
  return {
    current: stored === null ? null : Math.min(stored, environmentMaximum),
    base: overridden ? base : stored,
    override: overridden ? stored : null,
    overriddenAt,
  };
}

function applyLimitOverride(
  db: PrismaClientOrTransaction,
  row: TaskQueue,
  override: ConcurrencyLimitOverrideInput,
  overriddenBy?: User
) {
  const now = new Date();
  const data: Record<string, unknown> = {};

  if (override.perKey !== undefined) {
    data.concurrencyLimit = override.perKey;
    data.concurrencyLimitBase = row.concurrencyLimitOverriddenAt
      ? row.concurrencyLimitBase
      : (row.concurrencyLimit ?? null);
    data.concurrencyLimitOverriddenAt = now;
    data.concurrencyLimitOverriddenBy = overriddenBy?.id ?? null;
    data.concurrencyLimitOverridePercent = null;
  }

  if (override.total !== undefined) {
    data.totalConcurrencyLimit = override.total;
    data.totalConcurrencyLimitBase = row.totalConcurrencyLimitOverriddenAt
      ? row.totalConcurrencyLimitBase
      : (row.totalConcurrencyLimit ?? null);
    data.totalConcurrencyLimitOverriddenAt = now;
    data.totalConcurrencyLimitOverriddenBy = overriddenBy?.id ?? null;
  }

  return guardedLimitUpdate(db, row, data);
}

/**
 * Enforce first, then persist: the engine syncs to the declared base BEFORE the
 * override markers clear, so an engine failure leaves the markers set and a retry
 * converges instead of being rejected while the overridden limit stays enforced.
 */
/**
 * A paused row's pause IS the engine per-key value 0 (the DB concurrencyLimit
 * column keeps the configured value), so every per-key engine write from this
 * surface must preserve it — otherwise an override or reset that only touched
 * `total` would silently resume a queue every other surface still reports as
 * paused. QUEUE rows and named LIMIT rows pause the same way (queue pause and
 * `limits.pause` both set the flag), so both take the paused branch here.
 */
function perKeyEngineWrite(
  environment: AuthenticatedEnvironment,
  row: Pick<TaskQueue, "name" | "paused">,
  target: number | null | undefined
) {
  if (row.paused) {
    return updateQueueConcurrencyLimits(environment, row.name, 0);
  }
  return typeof target === "number"
    ? updateQueueConcurrencyLimits(environment, row.name, target)
    : removeQueueConcurrencyLimits(environment, row.name);
}

function syncResetToEngine(
  environment: AuthenticatedEnvironment,
  row: TaskQueue
): ResultAsync<
  TaskQueue,
  { type: "limit_not_overridden" } | { type: "sync_limit_to_engine_failed"; cause: unknown }
> {
  if (row.concurrencyLimitOverriddenAt === null && row.totalConcurrencyLimitOverriddenAt === null) {
    return errAsync({ type: "limit_not_overridden" as const });
  }

  const perKeyTarget = row.concurrencyLimitOverriddenAt
    ? row.concurrencyLimitBase
    : row.concurrencyLimit;
  const totalTarget = row.totalConcurrencyLimitOverriddenAt
    ? row.totalConcurrencyLimitBase
    : row.totalConcurrencyLimit;

  const perKeySync = perKeyEngineWrite(environment, row, perKeyTarget);

  const totalSync =
    typeof totalTarget === "number"
      ? updateQueueTotalConcurrencyLimits(environment, row.name, totalTarget)
      : removeQueueTotalConcurrencyLimits(environment, row.name);

  return fromPromise(settleBothEngineWrites(perKeySync, totalSync), (error) => ({
    type: "sync_limit_to_engine_failed" as const,
    cause: error,
  })).map(() => row);
}

/**
 * Pause and resume change only the per-key engine key (0 while paused, the
 * stored value or a removal on resume); the total key belongs to the bounds and
 * is left exactly as configured.
 */
function syncLimitPauseToEngine(environment: AuthenticatedEnvironment, row: TaskQueue) {
  return fromPromise(perKeyEngineWrite(environment, row, row.concurrencyLimit), (error) => ({
    type: "sync_limit_to_engine_failed" as const,
    cause: error,
  })).map(() => row);
}

function resetLimitOverrides(db: PrismaClientOrTransaction, row: TaskQueue) {
  const data: Record<string, unknown> = {};

  if (row.concurrencyLimitOverriddenAt !== null) {
    data.concurrencyLimit = row.concurrencyLimitBase;
    data.concurrencyLimitBase = null;
    data.concurrencyLimitOverriddenAt = null;
    data.concurrencyLimitOverriddenBy = null;
    data.concurrencyLimitOverridePercent = null;
  }

  if (row.totalConcurrencyLimitOverriddenAt !== null) {
    data.totalConcurrencyLimit = row.totalConcurrencyLimitBase;
    data.totalConcurrencyLimitBase = null;
    data.totalConcurrencyLimitOverriddenAt = null;
    data.totalConcurrencyLimitOverriddenBy = null;
  }

  return guardedLimitUpdate(db, row, data);
}

/**
 * Both engine writes settle before a failure is reported, so no write is still in
 * flight when a caller's compensation runs — a late sibling can never land after
 * the compensating re-sync and leave one bound stale.
 */
async function settleBothEngineWrites(a: Promise<unknown>, b: Promise<unknown>): Promise<void> {
  const results = await Promise.allSettled([a, b]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed && failed.status === "rejected") {
    throw failed.reason;
  }
}

/**
 * Optimistic update: the where clause carries the row's updatedAt plus both override
 * markers as read, so ANY concurrent write — another override or reset, or a deploy
 * refreshing the declared values — makes this update miss (P2025) and the caller
 * gets a conflict instead of persisting values computed from a stale row. The
 * markers narrow the same-millisecond updatedAt window to writes that also leave
 * both markers untouched.
 */
function guardedLimitUpdate(
  db: PrismaClientOrTransaction,
  row: TaskQueue,
  data: Record<string, unknown>
) {
  return fromPromise(
    db.taskQueue.update({
      where: {
        id: row.id,
        updatedAt: row.updatedAt,
        concurrencyLimitOverriddenAt: row.concurrencyLimitOverriddenAt,
        totalConcurrencyLimitOverriddenAt: row.totalConcurrencyLimitOverriddenAt,
      },
      data,
    }),
    (error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        return { type: "conflict" as const };
      }
      return { type: "limit_update_failed" as const, cause: error };
    }
  );
}

type SyncedLimitValues = { perKey: number | null; total: number | null; paused: boolean };

/**
 * Re-syncs the engine from fresh reads of the row until the enforced values stop
 * moving (bounded), the same convergence the deploy sync uses: every actor writes
 * Postgres before its own engine sync, so re-syncing whatever is freshest
 * converges. The fixpoint compares the values the engine enforces rather than
 * updatedAt, because Prisma's @updatedAt has millisecond precision and two writes
 * in the same millisecond are indistinguishable by timestamp. Matching values
 * only prove this actor once synced them, not that the engine still holds them
 * (another actor may have diverged it and written the same values back), but
 * skipping keeps divergence non-silent: a failed engine write always surfaces
 * to that actor's caller, which can retry, and a stale write landing after the
 * loop's final read (the loop is bounded) is healed by the next sync or deploy,
 * the same residual the deploy-time queue sync accepts. Callers use it two ways: after a failure (a reset's enforce-first engine write preceding a
 * persist that then conflicts, or an override's sync failing after its persist),
 * where the original error still reaches the caller; and after a successful sync
 * with `alreadySynced` set to the values just synced, where an unchanged row
 * costs one read and a moved row is re-synced.
 */
function compensateEngineFromFreshRow(
  db: PrismaClientOrTransaction,
  environment: AuthenticatedEnvironment,
  rowId: string,
  options?: { alreadySynced?: SyncedLimitValues }
) {
  return fromPromise(
    (async () => {
      let lastSynced: SyncedLimitValues | null = options?.alreadySynced ?? null;
      for (let i = 0; i < 3; i++) {
        const fresh = await db.taskQueue.findFirst({ where: { id: rowId } });
        if (
          !fresh ||
          (lastSynced !== null &&
            fresh.concurrencyLimit === lastSynced.perKey &&
            fresh.totalConcurrencyLimit === lastSynced.total &&
            fresh.paused === lastSynced.paused)
        ) {
          return;
        }
        await settleBothEngineWrites(
          perKeyEngineWrite(environment, fresh, fresh.concurrencyLimit),
          typeof fresh.totalConcurrencyLimit === "number"
            ? updateQueueTotalConcurrencyLimits(
                environment,
                fresh.name,
                fresh.totalConcurrencyLimit
              )
            : removeQueueTotalConcurrencyLimits(environment, fresh.name)
        );
        lastSynced = {
          perKey: fresh.concurrencyLimit,
          total: fresh.totalConcurrencyLimit,
          paused: fresh.paused,
        };
      }
    })(),
    (error) => {
      /** Callers on their success path swallow this error (their own persist and
       * sync succeeded; the next sync or deploy retries the residual), so the
       * failure must be observable here or it is silent. */
      logger.error("Failed to re-sync a concurrency limit from the fresh row", { error, rowId });
      return { type: "other" as const, cause: error };
    }
  );
}

/**
 * Pushes both engine keys from the row: the per-key limit (through the
 * pause-aware write, so a paused row keeps 0) and the total, which pause never
 * touches.
 */
function syncLimitToEngine(environment: AuthenticatedEnvironment, row: TaskQueue) {
  const perKeySync = perKeyEngineWrite(environment, row, row.concurrencyLimit);

  const totalSync =
    typeof row.totalConcurrencyLimit === "number"
      ? updateQueueTotalConcurrencyLimits(environment, row.name, row.totalConcurrencyLimit)
      : removeQueueTotalConcurrencyLimits(environment, row.name);

  return fromPromise(settleBothEngineWrites(perKeySync, totalSync), (error) => ({
    type: "sync_limit_to_engine_failed" as const,
    cause: error,
  })).map(() => row);
}
