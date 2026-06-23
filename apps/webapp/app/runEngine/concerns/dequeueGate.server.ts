import { getMeter } from "@internal/tracing";
import { env } from "~/env.server";
import {
  baseWorkerQueue,
  matchesDisabledWorkerQueue,
  parseDisabledWorkerQueues,
} from "./workerQueueSplit.server";

const meter = getMeter("run-engine-dequeue-gate");

const blockedDequeueCounter = meter.createCounter("run_engine.dequeue.blocked", {
  description:
    "Count of worker dequeue requests refused because the worker queue is gated off via RUN_ENGINE_DEQUEUE_DISABLED_WORKER_QUEUES",
});

const disabledWorkerQueues = parseDisabledWorkerQueues(
  env.RUN_ENGINE_DEQUEUE_DISABLED_WORKER_QUEUES
);

export function isWorkerQueueDequeueDisabled(workerQueue: string): boolean {
  return matchesDisabledWorkerQueue(workerQueue, disabledWorkerQueues);
}

export function recordBlockedDequeue(workerQueue: string): void {
  blockedDequeueCounter.add(1, {
    worker_queue: workerQueue,
    region: baseWorkerQueue(workerQueue),
  });
}
