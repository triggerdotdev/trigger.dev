import {
  formatWorkerQueue,
  WORKER_QUEUE_VERSION,
  WorkerQueueSubscriptions,
  type WeightedWorkerQueueSubscription,
  type WorkerQueueSubscription,
} from "@trigger.dev/core/v3/workers";
import type { WorkloadType } from "@trigger.dev/database";
import { z } from "zod";
import { ServiceValidationError } from "~/v3/services/common.server";
import { baseWorkerQueue } from "./workerQueueSplit.server";

export const WorkerQueueSubscriptionPolicyEnv = z
  .string()
  .default("{}")
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "Expected a JSON worker-group subscription map" });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string(), WorkerQueueSubscriptions));

export type WorkerQueueConsumerOptions = {
  workerGroupId: string;
  workerInstanceId: string;
  masterQueue: string;
  region: string | null;
  workloadType: WorkloadType;
  allowedSubscriptions: WorkerQueueSubscription[];
};

export type WorkerQueueConsumer = Omit<WorkerQueueConsumerOptions, "allowedSubscriptions"> & {
  allowedQueues: Map<string, string | undefined>;
};

export type ResolvedWorkerQueueSubscription = {
  queue: string;
  weight: number;
};

function subscriptionKey({
  class: queueClass,
  phase,
  compat,
  channel,
}: WorkerQueueSubscription): string {
  return `${queueClass}:${phase}:${compat}:${channel}`;
}

export function createWorkerQueueConsumer({
  allowedSubscriptions,
  ...worker
}: WorkerQueueConsumerOptions): WorkerQueueConsumer {
  const allowedQueues = new Map<string, string | undefined>(
    allowedSubscriptions.map((subscription) => [subscriptionKey(subscription), undefined])
  );
  return { ...worker, allowedQueues };
}

export function resolveWorkerQueueSubscriptions(
  worker: WorkerQueueConsumer,
  subscriptions: WeightedWorkerQueueSubscription[]
): ResolvedWorkerQueueSubscription[] {
  const runtime = worker.workloadType === "MICROVM" ? "compute" : "container";
  const workerQueues = new Map<string, ResolvedWorkerQueueSubscription>();

  for (const subscription of subscriptions) {
    const key = subscriptionKey(subscription);
    if (
      !worker.allowedQueues.has(key) ||
      (subscription.compat !== "any" && subscription.compat !== runtime)
    ) {
      throw new ServiceValidationError(
        `Worker group ${worker.workerGroupId} is not authorized to consume ${key}`,
        403
      );
    }

    let workerQueue = worker.allowedQueues.get(key);
    if (!workerQueue) {
      const region = worker.region ?? baseWorkerQueue(worker.masterQueue);
      try {
        workerQueue = formatWorkerQueue({ region, version: WORKER_QUEUE_VERSION, ...subscription });
      } catch {
        throw new ServiceValidationError(
          `Worker group ${worker.workerGroupId} does not have a valid region for v2 queues`,
          422
        );
      }
      worker.allowedQueues.set(key, workerQueue);
    }

    workerQueues.set(workerQueue, { queue: workerQueue, weight: subscription.weight ?? 1 });
  }

  return [...workerQueues.values()];
}
