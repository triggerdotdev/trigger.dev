import { TaskQueueType, type Prisma } from "@trigger.dev/database";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { engine } from "~/v3/runEngine.server";
import { BasePresenter } from "./basePresenter.server";

const MAX_ALLOCATION_QUEUES = 500;

export type QueueAllocationItem = {
  id: string;
  name: string;
  type: "task" | "custom";
  running: number;
  queued: number;
  paused: boolean;
  /** Explicit per-queue limit; null means the queue floats up to the env limit. */
  limit: number | null;
  overridden: boolean;
};

export type QueueAllocation = {
  queues: QueueAllocationItem[];
  totalQueues: number;
  truncated: boolean;
  /** Sum of explicit limits, each clamped to the env limit. */
  allocated: number;
  unlimitedCount: number;
};

/** Every queue in the environment (capped) with live counts, for the allocation view. */
export class QueueAllocationPresenter extends BasePresenter {
  public async call({
    environment,
  }: {
    environment: AuthenticatedEnvironment;
  }): Promise<QueueAllocation> {
    const where: Prisma.TaskQueueWhereInput = {
      runtimeEnvironmentId: environment.id,
      version: "V2",
    };

    const [totalQueues, queues] = await Promise.all([
      this._replica.taskQueue.count({ where }),
      this._replica.taskQueue.findMany({
        where,
        select: {
          friendlyId: true,
          name: true,
          type: true,
          paused: true,
          concurrencyLimit: true,
          concurrencyLimitOverriddenAt: true,
        },
        orderBy: { orderableName: "asc" },
        take: MAX_ALLOCATION_QUEUES,
      }),
    ]);

    const names = queues.map((q) => q.name);
    const [queuedByQueue, runningByQueue] = await Promise.all([
      engine.lengthOfQueues(environment, names),
      engine.currentConcurrencyOfQueues(environment, names),
    ]);

    const envLimit = environment.maximumConcurrencyLimit;
    let allocated = 0;
    let unlimitedCount = 0;

    const items: QueueAllocationItem[] = queues.map((queue) => {
      if (queue.concurrencyLimit === null) {
        unlimitedCount++;
      } else {
        allocated += Math.min(queue.concurrencyLimit, envLimit);
      }
      return {
        id: queue.friendlyId,
        name: queue.name.replace(/^task\//, ""),
        type: queue.type === TaskQueueType.VIRTUAL ? ("task" as const) : ("custom" as const),
        running: runningByQueue[queue.name] ?? 0,
        queued: queuedByQueue[queue.name] ?? 0,
        paused: queue.paused,
        limit: queue.concurrencyLimit,
        overridden: queue.concurrencyLimitOverriddenAt !== null,
      };
    });

    return {
      queues: items,
      totalQueues,
      truncated: totalQueues > queues.length,
      allocated,
      unlimitedCount,
    };
  }
}
