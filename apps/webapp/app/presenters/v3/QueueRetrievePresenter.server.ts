import { assertExhaustive } from "@trigger.dev/core";
import {
  QueueItem as QueueItemSchema,
  type Prettify,
  type QueueItem,
  type RetrieveQueueParam,
} from "@trigger.dev/core/v3";
import type { QueueLimits } from "~/components/queues/queue-limits";
import {
  type PrismaClientOrTransaction,
  type TaskQueue,
  type User,
  type TaskQueueType,
} from "@trigger.dev/database";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { engine } from "~/v3/runEngine.server";
import { BasePresenter } from "./basePresenter.server";

export type FoundQueue = Prettify<
  Omit<TaskQueue, "concurrencyLimitOverriddenBy"> & {
    concurrencyLimitOverriddenBy?: User | null;
  }
>;

/**
 * Shared queue lookup logic used by both QueueRetrievePresenter and PauseQueueService
 */
export async function getQueue(
  prismaClient: PrismaClientOrTransaction,
  environment: AuthenticatedEnvironment,
  queue: RetrieveQueueParam
) {
  const role = "QUEUE" as const;

  if (typeof queue === "string") {
    return joinQueueWithUser(
      prismaClient,
      await prismaClient.taskQueue.findFirst({
        where: {
          friendlyId: queue,
          runtimeEnvironmentId: environment.id,
          role,
        },
      })
    );
  }

  const queueName =
    queue.type === "task" ? `task/${queue.name.replace(/^task\//, "")}` : queue.name;
  return joinQueueWithUser(
    prismaClient,
    await prismaClient.taskQueue.findFirst({
      where: {
        name: queueName,
        runtimeEnvironmentId: environment.id,
        role,
      },
    })
  );
}

async function joinQueueWithUser(
  prismaClient: PrismaClientOrTransaction,
  queue?: TaskQueue | null
): Promise<FoundQueue | undefined> {
  if (!queue) return undefined;
  if (!queue.concurrencyLimitOverriddenBy) {
    return {
      ...queue,
      concurrencyLimitOverriddenBy: undefined,
    };
  }

  const user = await prismaClient.user.findFirst({
    where: { id: queue.concurrencyLimitOverriddenBy },
  });

  return {
    ...queue,
    concurrencyLimitOverriddenBy: user,
  };
}

export class QueueRetrievePresenter extends BasePresenter {
  public async call({
    environment,
    queueInput,
  }: {
    environment: AuthenticatedEnvironment;
    queueInput: RetrieveQueueParam;
  }) {
    const queue = await getQueue(this._replica, environment, queueInput);
    if (!queue) {
      return {
        success: false as const,
        code: "queue-not-found",
      };
    }

    const results = await Promise.all([
      engine.lengthOfQueues(environment, [queue.name]),
      engine.currentConcurrencyOfQueues(environment, [queue.name]),
      queue.totalConcurrencyLimit != null
        ? engine.totalConcurrencyOfQueues(environment, [queue.name])
        : undefined,
    ]);

    /** The returned queue = the public QueueItem fields plus dashboard extras
     * (percent override source, configured bounds); the public API routes strip
     * the extras via `toPublicQueueItem`. Prisma returns Decimal for the
     * percent; the client only needs a plain number (null for absolute). */
    return {
      success: true as const,
      queue: {
        ...toQueueItem({
          friendlyId: queue.friendlyId,
          name: queue.name,
          type: queue.type,
          version: queue.concurrencyVersion,
          running: results[1]?.[queue.name] ?? 0,
          queued: results[0]?.[queue.name] ?? 0,
          concurrencyLimit: queue.concurrencyLimit ?? null,
          concurrencyLimitBase: queue.concurrencyLimitBase ?? null,
          concurrencyLimitOverriddenAt: queue.concurrencyLimitOverriddenAt ?? null,
          concurrencyLimitOverriddenBy: queue.concurrencyLimitOverriddenBy ?? null,
          paused: queue.paused,
        }),
        concurrencyLimitOverridePercent:
          queue.concurrencyLimitOverridePercent !== null
            ? Number(queue.concurrencyLimitOverridePercent)
            : null,
        limits: toQueueLimits(queue, {
          totalRunning:
            queue.totalConcurrencyLimit != null ? (results[2]?.[queue.name] ?? 0) : null,
          overriddenByName: toQueueConcurrencyOverriddenBy(
            queue.concurrencyLimitOverriddenBy ?? null
          ),
        }),
      },
    };
  }
}

/**
 * The dashboard-only configured bounds of a row, independent of the public
 * shape's version discrimination (V2 queues expose no queue-level concurrency
 * publicly, but the dashboard still shows what's configured).
 */
export function toQueueLimits(
  row: {
    concurrencyLimit: number | null;
    concurrencyLimitBase: number | null;
    concurrencyLimitOverriddenAt: Date | null;
    totalConcurrencyLimit: number | null;
    totalConcurrencyLimitBase: number | null;
    totalConcurrencyLimitOverriddenAt: Date | null;
  },
  extras: { totalRunning: number | null; overriddenByName: string | null }
): QueueLimits {
  return {
    perKey: {
      current: row.concurrencyLimit,
      base: row.concurrencyLimitOverriddenAt ? row.concurrencyLimitBase : row.concurrencyLimit,
      override: row.concurrencyLimitOverriddenAt ? row.concurrencyLimit : null,
      overriddenAt: row.concurrencyLimitOverriddenAt,
      overriddenBy: extras.overriddenByName,
    },
    total:
      row.totalConcurrencyLimit !== null
        ? {
            current: row.totalConcurrencyLimit,
            base: row.totalConcurrencyLimitOverriddenAt
              ? row.totalConcurrencyLimitBase
              : row.totalConcurrencyLimit,
            override: row.totalConcurrencyLimitOverriddenAt ? row.totalConcurrencyLimit : null,
            overriddenAt: row.totalConcurrencyLimitOverriddenAt,
            running: extras.totalRunning,
          }
        : null,
  };
}

/**
 * The public API wire shape: the `QueueItem` contract exactly (dashboard extras
 * stripped by the schema parse) plus the legacy field older clients require.
 */
export function toPublicQueueItem(item: QueueItem): QueueItem & {
  releaseConcurrencyOnWaitpoint: boolean;
} {
  return { ...QueueItemSchema.parse(item), releaseConcurrencyOnWaitpoint: true };
}

export function queueTypeFromType(type: TaskQueueType) {
  switch (type) {
    case "NAMED":
      return "custom" as const;
    case "VIRTUAL":
      return "task" as const;
    default:
      assertExhaustive(type);
  }
}

/**
 * Converts raw queue data into the public QueueItem shape. The queue's version
 * discriminates it: V1 carries the queue's own limit and override state; V2
 * carries neither (a V2 queue is only the line — concurrency lives on the task
 * `concurrency` option and the `concurrencyLimits` surface), with
 * `concurrencyLimit` kept as null so older clients keep parsing.
 */
export function toQueueItem(data: {
  friendlyId: string;
  name: string;
  type: TaskQueueType;
  version: "V1" | "V2";
  running: number;
  queued: number;
  concurrencyLimit: number | null;
  concurrencyLimitBase: number | null;
  concurrencyLimitOverriddenAt: Date | null;
  concurrencyLimitOverriddenBy: User | null;
  paused: boolean;
}): QueueItem & { releaseConcurrencyOnWaitpoint: boolean } {
  const common = {
    id: data.friendlyId,
    //remove the task/ prefix if it exists
    name: data.name.replace(/^task\//, ""),
    type: queueTypeFromType(data.type),
    running: data.running,
    queued: data.queued,
    paused: data.paused,
    // TODO: This needs to be removed but keeping this here for now to avoid breaking existing clients
    releaseConcurrencyOnWaitpoint: true,
  };

  if (data.version === "V2") {
    return {
      ...common,
      version: "V2" as const,
      concurrencyLimit: null,
    };
  }

  return {
    ...common,
    version: "V1" as const,
    concurrencyLimit: data.concurrencyLimit,
    concurrency: {
      current: data.concurrencyLimit,
      base: data.concurrencyLimitBase,
      override: data.concurrencyLimitOverriddenAt ? data.concurrencyLimit : null,
      overriddenBy: toQueueConcurrencyOverriddenBy(data.concurrencyLimitOverriddenBy),
      overriddenAt: data.concurrencyLimitOverriddenAt,
    },
  };
}

function toQueueConcurrencyOverriddenBy(user: User | null) {
  if (!user) return null;

  return user.displayName ?? user.name ?? null;
}
