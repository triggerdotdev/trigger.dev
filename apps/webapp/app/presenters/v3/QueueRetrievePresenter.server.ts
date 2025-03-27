import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { engine } from "~/v3/runEngine.server";
import { BasePresenter } from "./basePresenter.server";
import { type TaskQueueType } from "@trigger.dev/database";
import { assertExhaustive } from "@trigger.dev/core";
import { determineEngineVersion } from "~/v3/engineVersion.server";
import { type QueueItem, type RetrieveQueueParam } from "@trigger.dev/core/v3";
import { PrismaClientOrTransaction } from "@trigger.dev/database";

/**
 * Shared queue lookup logic used by both QueueRetrievePresenter and PauseQueueService
 */
export async function getQueue(
  prismaClient: PrismaClientOrTransaction,
  environment: AuthenticatedEnvironment,
  queue: RetrieveQueueParam
) {
  if (typeof queue === "string") {
    return prismaClient.taskQueue.findFirst({
      where: {
        friendlyId: queue,
        runtimeEnvironmentId: environment.id,
      },
    });
  }

  const queueName =
    queue.type === "task" ? `task/${queue.name.replace(/^task\//, "")}` : queue.name;
  return prismaClient.taskQueue.findFirst({
    where: {
      name: queueName,
      runtimeEnvironmentId: environment.id,
    },
  });
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
        paused: queue.paused,
        releaseConcurrencyOnWaitpoint: queue.releaseConcurrencyOnWaitpoint,
      }),
    };
  }
}

function queueTypeFromType(type: TaskQueueType) {
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
  paused: boolean;
  releaseConcurrencyOnWaitpoint: boolean;
}): QueueItem {
  return {
    id: data.friendlyId,
    //remove the task/ prefix if it exists
    name: data.name.replace(/^task\//, ""),
    type: queueTypeFromType(data.type),
    running: data.running,
    queued: data.queued,
    concurrencyLimit: data.concurrencyLimit,
    paused: data.paused,
    releaseConcurrencyOnWaitpoint: data.releaseConcurrencyOnWaitpoint,
  };
}
