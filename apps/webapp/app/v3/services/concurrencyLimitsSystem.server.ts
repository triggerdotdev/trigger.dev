import type { TaskQueue, User } from "@trigger.dev/database";
import { errAsync, fromPromise, okAsync } from "neverthrow";
import type { PrismaClientOrTransaction } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  removeQueueConcurrencyLimits,
  removeQueueTotalConcurrencyLimits,
  updateQueueConcurrencyLimits,
  updateQueueTotalConcurrencyLimits,
} from "../runQueue.server";
import { engine } from "../runEngine.server";

export type ConcurrencyLimitsSystemOptions = {
  db: PrismaClientOrTransaction;
  reader: PrismaClientOrTransaction;
};

/** Queue rows that back named concurrency limits live under this reserved prefix. */
const LIMIT_QUEUE_PREFIX = "limit/";

const LIMIT_NAME_PATTERN = /^[a-zA-Z0-9_/-]{1,122}$/;

export type ConcurrencyLimitBoundValue = {
  current: number | null;
  base: number | null;
  override: number | null;
  overriddenAt: Date | null;
};

export type ConcurrencyLimitItem = {
  id: string;
  name: string;
  perKey: ConcurrencyLimitBoundValue;
  total: ConcurrencyLimitBoundValue;
  running: number;
  queued: number;
};

/**
 * An override changes only the given bounds; each bound is a non-negative integer
 * (zero blocks every run holding the limit, which is how a limit is paused).
 */
export type ConcurrencyLimitOverrideInput = {
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
            where: {
              runtimeEnvironmentId: environment.id,
              role: "LIMIT",
            },
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
          this.reader.taskQueue.count({
            where: { runtimeEnvironmentId: environment.id, role: "LIMIT" },
          }),
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
        }

        return findLimitByName(this.db, environment, name)
          .andThen((row) => applyLimitOverride(this.db, row, override, overriddenBy))
          .andThen((row) => syncLimitToEngine(environment, row))
          .andThen((row) =>
            fromPromise(toLimitItems(environment, [row]), (error) => ({
              type: "other" as const,
              cause: error,
            })).map((items) => items[0])
          );
      },
      reset: (environment: AuthenticatedEnvironment, name: string) => {
        return findLimitByName(this.db, environment, name)
          .andThen((row) => resetLimitOverrides(this.db, row))
          .andThen((row) => syncLimitToEngine(environment, row))
          .andThen((row) =>
            fromPromise(toLimitItems(environment, [row]), (error) => ({
              type: "other" as const,
              cause: error,
            })).map((items) => items[0])
          );
      },
    };
  }
}

export function concurrencyLimitDisplayId(row: Pick<TaskQueue, "friendlyId">): string {
  return `climit_${row.friendlyId.replace(/^queue_/, "")}`;
}

export function concurrencyLimitNameFromRow(row: Pick<TaskQueue, "name">): string {
  return row.name.startsWith(LIMIT_QUEUE_PREFIX)
    ? row.name.slice(LIMIT_QUEUE_PREFIX.length)
    : row.name;
}

function findLimitByName(
  db: PrismaClientOrTransaction,
  environment: AuthenticatedEnvironment,
  name: string
) {
  if (!LIMIT_NAME_PATTERN.test(name)) {
    return errAsync({ type: "limit_not_found" as const });
  }

  return fromPromise(
    db.taskQueue.findFirst({
      where: {
        runtimeEnvironmentId: environment.id,
        name: `${LIMIT_QUEUE_PREFIX}${name}`,
        role: "LIMIT",
      },
    }),
    (error) => ({ type: "other" as const, cause: error })
  ).andThen((row) => {
    if (!row) {
      return errAsync({ type: "limit_not_found" as const });
    }
    return okAsync(row);
  });
}

async function toLimitItems(
  environment: AuthenticatedEnvironment,
  rows: TaskQueue[]
): Promise<ConcurrencyLimitItem[]> {
  const names = rows.map((row) => row.name);
  const [running, queued] = await Promise.all([
    engine.totalConcurrencyOfQueues(environment, names),
    engine.gateQueuedCountOfQueues(environment, names),
  ]);

  return rows.map((row) => ({
    id: concurrencyLimitDisplayId(row),
    name: concurrencyLimitNameFromRow(row),
    perKey: toBound(
      row.concurrencyLimit,
      row.concurrencyLimitBase,
      row.concurrencyLimitOverriddenAt
    ),
    total: toBound(
      row.totalConcurrencyLimit,
      row.totalConcurrencyLimitBase,
      row.totalConcurrencyLimitOverriddenAt
    ),
    running: running[row.name] ?? 0,
    queued: queued[row.name] ?? 0,
  }));
}

function toBound(
  current: number | null,
  base: number | null,
  overriddenAt: Date | null
): ConcurrencyLimitBoundValue {
  const overridden = overriddenAt !== null;
  return {
    current,
    base: overridden ? base : current,
    override: overridden ? current : null,
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
  }

  if (override.total !== undefined) {
    data.totalConcurrencyLimit = override.total;
    data.totalConcurrencyLimitBase = row.totalConcurrencyLimitOverriddenAt
      ? row.totalConcurrencyLimitBase
      : (row.totalConcurrencyLimit ?? null);
    data.totalConcurrencyLimitOverriddenAt = now;
    data.totalConcurrencyLimitOverriddenBy = overriddenBy?.id ?? null;
  }

  return fromPromise(db.taskQueue.update({ where: { id: row.id }, data }), (error) => ({
    type: "limit_update_failed" as const,
    cause: error,
  }));
}

function resetLimitOverrides(db: PrismaClientOrTransaction, row: TaskQueue) {
  if (row.concurrencyLimitOverriddenAt === null && row.totalConcurrencyLimitOverriddenAt === null) {
    return errAsync({ type: "limit_not_overridden" as const });
  }

  const data: Record<string, unknown> = {};

  if (row.concurrencyLimitOverriddenAt !== null) {
    data.concurrencyLimit = row.concurrencyLimitBase;
    data.concurrencyLimitBase = null;
    data.concurrencyLimitOverriddenAt = null;
    data.concurrencyLimitOverriddenBy = null;
  }

  if (row.totalConcurrencyLimitOverriddenAt !== null) {
    data.totalConcurrencyLimit = row.totalConcurrencyLimitBase;
    data.totalConcurrencyLimitBase = null;
    data.totalConcurrencyLimitOverriddenAt = null;
    data.totalConcurrencyLimitOverriddenBy = null;
  }

  return fromPromise(db.taskQueue.update({ where: { id: row.id }, data }), (error) => ({
    type: "limit_update_failed" as const,
    cause: error,
  }));
}

/**
 * Pushes both engine keys from the row: the per-key limit and the total. Limit
 * rows are never paused (pausing a limit is an override to `{ total: 0 }`), so
 * both keys sync unconditionally, unlike queue rows.
 */
function syncLimitToEngine(environment: AuthenticatedEnvironment, row: TaskQueue) {
  const perKeySync =
    typeof row.concurrencyLimit === "number"
      ? updateQueueConcurrencyLimits(environment, row.name, row.concurrencyLimit)
      : removeQueueConcurrencyLimits(environment, row.name);

  const totalSync =
    typeof row.totalConcurrencyLimit === "number"
      ? updateQueueTotalConcurrencyLimits(environment, row.name, row.totalConcurrencyLimit)
      : removeQueueTotalConcurrencyLimits(environment, row.name);

  return fromPromise(Promise.all([perKeySync, totalSync]), (error) => ({
    type: "sync_limit_to_engine_failed" as const,
    cause: error,
  })).map(() => row);
}
