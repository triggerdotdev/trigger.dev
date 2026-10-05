import type { RunEngine } from "@internal/run-engine";
import type {
  WeightedWorkerQueueSubscription,
  WorkerQueueClass,
} from "@trigger.dev/core/v3/workers";
import { isWorkerQueueDequeueDisabled, recordBlockedDequeue } from "./dequeueGate.server";
import { workerQueueForClass } from "./workerQueueSplit.server";
import {
  resolveWorkerQueueSubscriptions,
  type WorkerQueueConsumer,
} from "./workerQueueSubscriptions.server";

export function dequeueWorkerQueues({
  engine,
  worker,
  runnerId,
  queueClass,
  subscriptions,
}: {
  engine: RunEngine;
  worker: WorkerQueueConsumer;
  runnerId?: string;
  queueClass?: WorkerQueueClass;
  subscriptions?: WeightedWorkerQueueSubscription[];
}) {
  const workerQueues = subscriptions
    ? resolveWorkerQueueSubscriptions(worker, subscriptions)
    : [{ queue: workerQueueForClass(worker.masterQueue, queueClass), weight: 1 }];

  const enabledQueues = workerQueues.filter(({ queue }) => {
    if (isWorkerQueueDequeueDisabled(queue, subscriptions ? "v2" : "legacy")) {
      recordBlockedDequeue(queue);
      return false;
    }
    return true;
  });
  if (enabledQueues.length === 0) {
    return Promise.resolve([]);
  }

  return engine.dequeueFromWorkerQueues({
    consumerId: worker.workerInstanceId,
    workerQueues: enabledQueues,
    workerId: worker.workerInstanceId,
    runnerId,
  });
}
