import { TaskQueue, User } from "@trigger.dev/database";
import { errAsync, fromPromise, okAsync } from "neverthrow";
import { PrismaClientOrTransaction } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { removeQueueConcurrencyLimits, updateQueueConcurrencyLimits } from "../runQueue.server";
import { engine } from "../runEngine.server";

export type ConcurrencySystemOptions = {
  db: PrismaClientOrTransaction;
  reader: PrismaClientOrTransaction;
};

export type QueueInput = string | { type: "task" | "custom"; name: string };

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
        concurrencyLimit: number,
        overriddenBy?: User
      ) => {
        return findQueueFromInput(this.db, environment, queue)
          .andThen((queue) =>
            overrideQueueConcurrencyLimit(
              this.db,
              environment,
              queue,
              concurrencyLimit,
              overriddenBy
            )
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
  concurrencyLimit: number,
  overriddenBy?: User
) {
  const newConcurrencyLimit = Math.max(
    Math.min(concurrencyLimit, environment.maximumConcurrencyLimit),
    0
  );

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
