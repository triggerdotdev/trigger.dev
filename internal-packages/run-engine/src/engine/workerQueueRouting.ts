import type { TaskRun, TaskRunCheckpoint } from "@trigger.dev/database";
import {
  formatWorkerQueue,
  restoreWorkerQueue,
  WORKER_QUEUE_VERSION,
  type WorkerQueueDispatchClass,
} from "@trigger.dev/core/v3/workers";
import type { MinimalAuthenticatedEnvironment } from "../shared/index.js";

export function legacyToV2WorkerQueues(
  legacyWorkerQueues: readonly string[]
): ReadonlyMap<string, string> {
  const v2 = (region: string, queueClass: WorkerQueueDispatchClass) =>
    formatWorkerQueue({
      region,
      version: WORKER_QUEUE_VERSION,
      class: queueClass,
      phase: "fresh",
      compat: "container",
      channel: "stable",
    });

  return new Map(
    legacyWorkerQueues.flatMap((region) => [
      [region, v2(region, "ondemand")],
      [
        formatWorkerQueue({ region, version: "legacy", class: "scheduled" }),
        v2(region, "scheduled"),
      ],
    ])
  );
}

export function workerQueueForPublish(
  run: Pick<TaskRun, "workerQueue">,
  env: Pick<MinimalAuthenticatedEnvironment, "id" | "type">,
  checkpoint?: Pick<TaskRunCheckpoint, "type">,
  legacyToV2: ReadonlyMap<string, string> = new Map()
): string {
  if (env.type === "DEVELOPMENT") {
    return env.id;
  }

  const workerQueue = legacyToV2.get(run.workerQueue) ?? run.workerQueue;
  return checkpoint
    ? restoreWorkerQueue(workerQueue, checkpoint.type === "COMPUTE" ? "compute" : "container")
    : workerQueue;
}
