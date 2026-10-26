import type { RunEngine } from "@internal/run-engine";
import { getMeter } from "@internal/tracing";
import {
  formatWorkerQueue,
  parseWorkerQueue,
  type WeightedWorkerQueueSubscription,
  type WorkerQueue,
  type WorkerQueueClass,
} from "@trigger.dev/core/v3/workers";
import { logger } from "~/services/logger.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import {
  containerQueueForComputeQueue,
  workerRegionRegistry,
  type WorkerGroupRegionRow,
} from "~/v3/workerRegions.server";
import { isWorkerQueueDequeueDisabled, recordBlockedDequeue } from "./dequeueGate.server";
import { workerQueueForClass } from "./workerQueueSplit.server";
import {
  resolveWorkerQueueSubscriptions,
  subscriptionKey,
  type WorkerQueueConsumer,
} from "./workerQueueSubscriptions.server";

const anyLaneDequeueCounter = getMeter("run-engine-dequeue").createCounter(
  "run_engine.dequeue.any_lane",
  { description: "Runs taken from an any lane, by the runtime of the consumer that took them" }
);

export function dequeueWorkerQueues({
  engine,
  worker,
  runnerId,
  queueClass,
  subscriptions,
  workerGroups = () => workerRegionRegistry.current() ?? [],
}: {
  engine: RunEngine;
  worker: WorkerQueueConsumer;
  runnerId?: string;
  queueClass?: WorkerQueueClass;
  subscriptions?: WeightedWorkerQueueSubscription[];
  /** Defaults to the worker region registry. */
  workerGroups?: () => WorkerGroupRegionRow[];
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

  const runtime = consumerRuntime(worker, subscriptions);
  return engine
    .dequeueFromWorkerQueues({
      consumerId: worker.workerInstanceId,
      workerQueues: enabledQueues,
      workerId: worker.workerInstanceId,
      runnerId,
      templateFallbackWorkerQueue: templateFallbackFor(worker, runtime, workerGroups),
    })
    .then((messages) => {
      for (const message of messages) {
        recordAnyLaneDequeue(message.run.id, message.run.masterQueue, runtime);
      }
      return messages;
    });
}

/**
 * A group can carry container and compute consumers side by side, so on v2 queues a consumer's
 * runtime comes from the lanes it asks for rather than from its group. A consumer serves one
 * runtime; `any` lanes are shared, and either runtime takes their items first come, first served.
 * A request for `any` lanes only says nothing about the runtime, and neither do legacy queues: both
 * follow the group.
 */
export function consumerRuntime(
  worker: Pick<WorkerQueueConsumer, "workerGroupId" | "workloadType">,
  subscriptions: WeightedWorkerQueueSubscription[] | undefined
): "container" | "compute" {
  const compats = new Set(
    (subscriptions ?? []).map(({ compat }) => compat).filter((compat) => compat !== "any")
  );
  if (compats.size > 1) {
    throw new ServiceValidationError(
      `A consumer of worker group ${worker.workerGroupId} serves one runtime, not ${[...compats].join(" and ")}`,
      422
    );
  }
  const [compat] = compats;
  return compat ?? (worker.workloadType === "MICROVM" ? "compute" : "container");
}

/**
 * A compute consumer starts only deployments with a template; the rest move to a container lane in
 * the same region. That lane is served when a container group serves the region, or when the
 * consumer's own group, which may be the region's only group, is allowed it.
 */
export function templateFallbackFor(
  worker: Pick<WorkerQueueConsumer, "allowedQueues">,
  runtime: "container" | "compute",
  workerGroups: () => WorkerGroupRegionRow[]
): ((queue: string) => string | undefined) | undefined {
  if (runtime !== "compute") return undefined;
  return (queue) =>
    containerQueueForComputeQueue(queue, workerGroups()) ?? ownContainerLane(worker, queue);
}

function ownContainerLane(
  worker: Pick<WorkerQueueConsumer, "allowedQueues">,
  queue: string
): string | undefined {
  const parsed = parseQueue(queue);
  if (!parsed || parsed.version === "legacy" || parsed.compat === "container") return undefined;
  const lane = { ...parsed, compat: "container" as const, channel: "stable" as const };
  return worker.allowedQueues.has(subscriptionKey(lane)) ? formatWorkerQueue(lane) : undefined;
}

function recordAnyLaneDequeue(runId: string, queue: string, runtime: "container" | "compute") {
  const parsed = parseQueue(queue);
  if (!parsed || parsed.version === "legacy" || parsed.compat !== "any") return;
  anyLaneDequeueCounter.add(1, { runtime });
  logger.info("Run taken from an any lane", { runId, workerQueue: queue, runtime });
}

function parseQueue(queue: string): WorkerQueue | undefined {
  try {
    return parseWorkerQueue(queue);
  } catch {
    return undefined;
  }
}
