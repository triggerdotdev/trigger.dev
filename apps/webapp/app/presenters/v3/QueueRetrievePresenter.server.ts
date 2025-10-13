import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { engine } from "~/v3/runEngine.server";
import { BasePresenter } from "./basePresenter.server";
import { TaskQueue, User, type TaskQueueType } from "@trigger.dev/database";
import { assertExhaustive } from "@trigger.dev/core";
import { determineEngineVersion } from "~/v3/engineVersion.server";
import { type Prettify, type QueueItem, type RetrieveQueueParam } from "@trigger.dev/core/v3";
import { PrismaClientOrTransaction } from "@trigger.dev/database";

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
  if (typeof queue === "string") {
    return joinQueueWithUser(
      prismaClient,
      await prismaClient.taskQueue.findFirst({
        where: {
          friendlyId: queue,
          runtimeEnvironmentId: environment.id,
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
    //check the engine is the correct version
    const engineVersion = await determineEngineVersion({ environment });

    if (engineVersion === "V1") {
      return {
        success: false as const,
        code: "engine-version",
      };
    }

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
    ]);

    // Transform queues to include running and queued counts
    return {
      success: true as const,
      queue: toQueueItem({
        friendlyId: queue.friendlyId,
        name: queue.name,
        type: queue.type,
        running: results[1]?.[queue.name] ?? 0,
        queued: results[0]?.[queue.name] ?? 0,
        concurrencyLimit: queue.concurrencyLimit ?? null,
        concurrencyLimitBase: queue.concurrencyLimitBase ?? null,
        concurrencyLimitOverriddenAt: queue.concurrencyLimitOverriddenAt ?? null,
        concurrencyLimitOverriddenBy: queue.concurrencyLimitOverriddenBy ?? null,
        paused: queue.paused,
      }),
    };
  }
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
 * Converts raw queue data into a standardized QueueItem format
 * @param data Raw queue data containing required queue properties
 * @returns A validated QueueItem object
 */
export function toQueueItem(data: {
  friendlyId: string;
  name: string;
  type: TaskQueueType;
  running: number;
  queued: number;
  concurrencyLimit: number | null;
  concurrencyLimitBase: number | null;
  concurrencyLimitOverriddenAt: Date | null;
  concurrencyLimitOverriddenBy: User | null;
  paused: boolean;
}): QueueItem & { releaseConcurrencyOnWaitpoint: boolean } {
  return {
    id: data.friendlyId,
    //remove the task/ prefix if it exists
    name: data.name.replace(/^task\//, ""),
    type: queueTypeFromType(data.type),
    running: data.running,
    queued: data.queued,
    paused: data.paused,
    concurrencyLimit: data.concurrencyLimit,
    concurrency: {
      current: data.concurrencyLimit,
      base: data.concurrencyLimitBase,
      override: data.concurrencyLimitOverriddenAt ? data.concurrencyLimit : null,
      overriddenBy: toQueueConcurrencyOverriddenBy(data.concurrencyLimitOverriddenBy),
      overriddenAt: data.concurrencyLimitOverriddenAt,
    },
    // TODO: This needs to be removed but keeping this here for now to avoid breaking existing clients
    releaseConcurrencyOnWaitpoint: true,
  };
}

function toQueueConcurrencyOverriddenBy(user: User | null) {
  if (!user) return null;

  return user.displayName ?? user.name ?? null;
}
