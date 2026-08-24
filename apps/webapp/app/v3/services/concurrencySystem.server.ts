import type { TaskQueue, User } from "@trigger.dev/database";
import { errAsync, fromPromise, okAsync } from "neverthrow";
import type { PrismaClientOrTransaction } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { removeQueueConcurrencyLimits, updateQueueConcurrencyLimits } from "../runQueue.server";
import { engine } from "../runEngine.server";

export type ConcurrencySystemOptions = {
  db: PrismaClientOrTransaction;
  reader: PrismaClientOrTransaction;
};

type QueueInput = string | { type: "task" | "custom"; name: string };

/**
 * The concurrency-limit override to apply to a queue. Either an absolute `limit` or a `percent`
 * of the environment's maximum concurrency limit. A bare `number` is accepted for backwards
 * compatibility and is treated as an absolute limit.
 */
type ConcurrencyLimitOverride = number | { limit: number } | { percent: number };

/**
 * Materializes an absolute concurrency limit from a percentage of the environment limit.
 * Reused by the recalculation task that runs when an environment limit changes.
 *
 * Clamped to `>= 1` so a percent-based override never produces a `0` (pause-like) limit, and
 * to `<= envLimit` so it can never exceed the environment maximum.
 */
/**
 * Valid range for a percent-based queue concurrency override: greater than 0 and up to 100% of
 * the environment limit. Shared by every layer that validates the percent (the API zod schema,
 * the dashboard mutation handler, and the override service) so the bound never drifts apart.
 */
export const MIN_QUEUE_OVERRIDE_PERCENT = 0;
export const MAX_QUEUE_OVERRIDE_PERCENT = 100;

/** Whether `percent` is a valid queue-override percentage (0 < percent <= 100). */
export function isValidQueueOverridePercent(percent: number): boolean {
  return (
    Number.isFinite(percent) &&
    percent > MIN_QUEUE_OVERRIDE_PERCENT &&
    percent <= MAX_QUEUE_OVERRIDE_PERCENT
  );
}

export function materializePercentLimit(envLimit: number, percent: number): number {
  const materialized = Math.floor((envLimit * percent) / 100);
  return Math.min(Math.max(materialized, 1), envLimit);
}

export class ConcurrencySystem {
  constructor(private readonly options: ConcurrencySystemOptions) {}

  private get db() {
    return this.options.db;
  }

  get queues() {
    return {
      overrideQueueConcurrencyLimit: (
        environment: AuthenticatedEnvironment,
        queue: QueueInput,
        override: ConcurrencyLimitOverride,
        overriddenBy?: User
      ) => {
        return findQueueFromInput(this.db, environment, queue)
          .andThen((queue) =>
            overrideQueueConcurrencyLimit(this.db, environment, queue, override, overriddenBy)
          )
          .andThen((queue) => syncQueueConcurrencyToEngine(environment, queue))
          .andThen((queue) => getQueueStats(environment, queue));
      },
      resetConcurrencyLimit: (environment: AuthenticatedEnvironment, queue: QueueInput) => {
        return findQueueFromInput(this.db, environment, queue)
          .andThen((queue) => resetQueueConcurrencyLimit(this.db, queue))
          .andThen((queue) => syncQueueConcurrencyToEngine(environment, queue))
          .andThen((queue) => getQueueStats(environment, queue));
      },
      /**
       * Recalculates the materialized limit of every percent-based override in the environment
       * against its CURRENT maximumConcurrencyLimit and syncs changed queues to the run engine.
       * Call AFTER the environment-limit DB update has committed (engine syncs must not run
       * inside an open transaction). Idempotent: unchanged queues are skipped. One failing queue
       * is logged and skipped so the rest still converge.
       */
      recalculatePercentLimits: async (environment: AuthenticatedEnvironment) => {
        const queues = await this.db.taskQueue.findMany({
          where: {
            runtimeEnvironmentId: environment.id,
            concurrencyLimitOverridePercent: { not: null },
          },
        });

        let updated = 0;
        for (const queue of queues) {
          try {
            const percent = queue.concurrencyLimitOverridePercent;
            if (percent === null) continue;
            const newLimit = materializePercentLimit(
              environment.maximumConcurrencyLimit,
              percent.toNumber()
            );

            // Only write the DB when the materialized value actually changed.
            if (newLimit !== queue.concurrencyLimit) {
              await this.db.taskQueue.update({
                where: { id: queue.id },
                data: { concurrencyLimit: newLimit },
              });
              updated++;
            }

            // Always attempt the engine push (it's idempotent) for active queues — even when the
            // DB value was unchanged — so a previously-failed sync self-heals on the next recalc
            // instead of leaving the DB and engine diverged forever. Paused queues keep their
            // engine limit at 0 (the pause/resume flow re-syncs from the stored value on resume);
            // push nothing for them so a percent recalc never effectively un-pauses a queue.
            if (!queue.paused) {
              await updateQueueConcurrencyLimits(environment, queue.name, newLimit);
            }
          } catch (error) {
            logger.error("Failed to recalculate percent queue limit", {
              queueId: queue.id,
              environmentId: environment.id,
              error,
            });
          }
        }

        return { total: queues.length, updated };
      },
    };
  }
}

function findQueueFromInput(
  db: PrismaClientOrTransaction,
  environment: AuthenticatedEnvironment,
  queue: QueueInput
) {
  if (typeof queue === "string") {
    return findQueueByFriendlyId(db, environment, queue);
  }

  const queueName =
    queue.type === "task" ? `task/${queue.name.replace(/^task\//, "")}` : queue.name;

  return findQueueByName(db, environment, queueName);
}

function findQueueByFriendlyId(
  db: PrismaClientOrTransaction,
  environment: AuthenticatedEnvironment,
  friendlyId: string
) {
  return fromPromise(
    db.taskQueue.findFirst({
      where: {
        runtimeEnvironmentId: environment.id,
        friendlyId,
      },
    }),
    (error) => ({
      type: "other" as const,
      cause: error,
    })
  ).andThen((queue) => {
    if (!queue) {
      return errAsync({ type: "queue_not_found" as const });
    }
    return okAsync(queue);
  });
}

function findQueueByName(
  db: PrismaClientOrTransaction,
  environment: AuthenticatedEnvironment,
  queue: string
) {
  return fromPromise(
    db.taskQueue.findFirst({
      where: {
        runtimeEnvironmentId: environment.id,
        name: queue,
      },
    }),
    (error) => ({
      type: "other" as const,
      cause: error,
    })
  ).andThen((queue) => {
    if (!queue) {
      return errAsync({ type: "queue_not_found" as const });
    }
    return okAsync(queue);
  });
}

function overrideQueueConcurrencyLimit(
  db: PrismaClientOrTransaction,
  environment: AuthenticatedEnvironment,
  queue: TaskQueue,
  override: ConcurrencyLimitOverride,
  overriddenBy?: User
) {
  const maximum = environment.maximumConcurrencyLimit;

  // Normalize the input into the absolute limit to persist and the percent source-of-truth
  // (null for absolute overrides).
  let newConcurrencyLimit: number;
  let overridePercent: number | null;

  if (typeof override === "object" && "percent" in override) {
    const percent = override.percent;

    if (!isValidQueueOverridePercent(percent)) {
      return errAsync({
        type: "invalid_override" as const,
        message: `Percent must be greater than ${MIN_QUEUE_OVERRIDE_PERCENT} and less than or equal to ${MAX_QUEUE_OVERRIDE_PERCENT}`,
      });
    }

    newConcurrencyLimit = materializePercentLimit(maximum, percent);
    overridePercent = percent;
  } else {
    const limit = typeof override === "number" ? override : override.limit;

    if (!Number.isFinite(limit) || limit < 0) {
      return errAsync({
        type: "invalid_override" as const,
        message: "Concurrency limit must be a non-negative number",
      });
    }

    // Cap: an absolute override may not exceed the environment limit. Reject rather than clamp.
    if (limit > maximum) {
      return errAsync({
        type: "concurrency_limit_exceeds_maximum" as const,
        message: `Concurrency limit (${limit}) cannot exceed the environment limit (${maximum})`,
      });
    }

    newConcurrencyLimit = limit;
    overridePercent = null;
  }

  const concurrencyLimitBase = queue.concurrencyLimitOverriddenAt
    ? queue.concurrencyLimitBase
    : queue.concurrencyLimit;

  return fromPromise(
    db.taskQueue.update({
      where: {
        id: queue.id,
      },
      data: {
        concurrencyLimit: newConcurrencyLimit,
        concurrencyLimitBase: concurrencyLimitBase ?? null,
        concurrencyLimitOverridePercent: overridePercent,
        concurrencyLimitOverriddenAt: new Date(),
        concurrencyLimitOverriddenBy: overriddenBy?.id ?? null,
      },
    }),
    (error) => ({
      type: "queue_update_failed" as const,
      cause: error,
    })
  );
}

function resetQueueConcurrencyLimit(db: PrismaClientOrTransaction, queue: TaskQueue) {
  if (queue.concurrencyLimitOverriddenAt === null) {
    return errAsync({ type: "queue_not_overridden" as const });
  }

  const newConcurrencyLimit = queue.concurrencyLimitBase;

  return fromPromise(
    db.taskQueue.update({
      where: { id: queue.id },
      data: {
        concurrencyLimitOverriddenAt: null,
        concurrencyLimit: newConcurrencyLimit,
        concurrencyLimitBase: null,
        concurrencyLimitOverridePercent: null,
        concurrencyLimitOverriddenBy: null,
      },
    }),
    (error) => ({
      type: "queue_update_failed" as const,
      cause: error,
    })
  );
}

function syncQueueConcurrencyToEngine(environment: AuthenticatedEnvironment, queue: TaskQueue) {
  if (queue.paused) {
    // Queue is paused, don't update Redis limits - keep at 0
    return okAsync(queue);
  }

  if (typeof queue.concurrencyLimit === "number") {
    return fromPromise(
      updateQueueConcurrencyLimits(environment, queue.name, queue.concurrencyLimit),
      (error) => ({
        type: "sync_queue_concurrency_to_engine_failed" as const,
        cause: error,
      })
    ).andThen(() => okAsync(queue));
  } else {
    return fromPromise(removeQueueConcurrencyLimits(environment, queue.name), (error) => ({
      type: "sync_queue_concurrency_to_engine_failed" as const,
      cause: error,
    })).andThen(() => okAsync(queue));
  }
}

function getQueueStats(environment: AuthenticatedEnvironment, queue: TaskQueue) {
  return fromPromise(
    Promise.all([
      engine.lengthOfQueues(environment, [queue.name]),
      engine.currentConcurrencyOfQueues(environment, [queue.name]),
    ]),
    (error) => ({
      type: "get_queue_stats_failed" as const,
      cause: error,
    })
  ).andThen(([queued, running]) =>
    okAsync({ queued: queued[queue.name] ?? 0, running: running[queue.name] ?? 0, ...queue })
  );
}
