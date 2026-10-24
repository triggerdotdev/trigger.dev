import {
  formatWorkerQueue,
  legacyScheduledWorkerQueue,
  parseWorkerQueue,
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
  /** The group carries container and compute consumers side by side. */
  mixedRuntime?: boolean;
};

export type WorkerQueueConsumer = Omit<
  WorkerQueueConsumerOptions,
  "allowedSubscriptions" | "mixedRuntime"
> & {
  allowedQueues: Map<string, string | undefined>;
};

export type ResolvedWorkerQueueSubscription = {
  queue: string;
  weight: number;
};

export function subscriptionKey({
  class: queueClass,
  phase,
  compat,
  channel,
}: WorkerQueueSubscription): string {
  return `${queueClass}:${phase}:${compat}:${channel}`;
}

/**
 * A compute runner given a container lane would take runs that have no template. A MICROVM group's
 * consumers are compute unless the group is marked mixed, so its container lanes are refused.
 */
export function refusedSubscriptions({
  allowedSubscriptions,
  workloadType,
  mixedRuntime,
}: WorkerQueueConsumerOptions): WorkerQueueSubscription[] {
  if (workloadType !== "MICROVM" || mixedRuntime) return [];
  return allowedSubscriptions.filter((subscription) => subscription.compat === "container");
}

export function createWorkerQueueConsumer(
  options: WorkerQueueConsumerOptions
): WorkerQueueConsumer {
  const { allowedSubscriptions, mixedRuntime: _, ...worker } = options;
  const refused = new Set(refusedSubscriptions(options));
  const allowedQueues = new Map<string, string | undefined>(
    allowedSubscriptions
      .filter((subscription) => !refused.has(subscription))
      .map((subscription) => [subscriptionKey(subscription), undefined])
  );
  return { ...worker, allowedQueues };
}

// The group's allowlist, less any lanes refusedSubscriptions drops, is the whole gate: a region's
// group can carry container and compute cells side by side, each consuming the lanes its own runtime
// serves, so the group's workloadType says nothing about which compat a given consumer may take.
export function resolveWorkerQueueSubscriptions(
  worker: WorkerQueueConsumer,
  subscriptions: WeightedWorkerQueueSubscription[]
): ResolvedWorkerQueueSubscription[] {
  const workerQueues = new Map<string, ResolvedWorkerQueueSubscription>();

  for (const subscription of subscriptions) {
    const key = subscriptionKey(subscription);
    if (!worker.allowedQueues.has(key)) {
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

/**
 * Whether the worker's group serves `workerQueue`: the group's own legacy queue of either class,
 * or a v2 queue in its region that its allowed subscriptions cover.
 */
export function workerServesQueue(worker: WorkerQueueConsumer, workerQueue: string): boolean {
  if (
    workerQueue === worker.masterQueue ||
    workerQueue === legacyScheduledWorkerQueue(worker.masterQueue)
  ) {
    return true;
  }
  let parsed;
  try {
    parsed = parseWorkerQueue(workerQueue);
  } catch {
    return false;
  }
  return (
    parsed.version === WORKER_QUEUE_VERSION &&
    parsed.region === (worker.region ?? baseWorkerQueue(worker.masterQueue)) &&
    worker.allowedQueues.has(subscriptionKey(parsed))
  );
}
