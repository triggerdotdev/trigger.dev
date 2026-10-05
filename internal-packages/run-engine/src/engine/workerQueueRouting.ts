import type { TaskRun, TaskRunCheckpoint } from "@trigger.dev/database";
import { restoreWorkerQueue } from "@trigger.dev/core/v3/workers";
import type { MinimalAuthenticatedEnvironment } from "../shared/index.js";

export function workerQueueForPublish(
  run: Pick<TaskRun, "workerQueue">,
  env: Pick<MinimalAuthenticatedEnvironment, "id" | "type">,
  checkpoint?: Pick<TaskRunCheckpoint, "type">
): string {
  if (env.type === "DEVELOPMENT") {
    return env.id;
  }

  return checkpoint
    ? restoreWorkerQueue(run.workerQueue, checkpoint.type === "COMPUTE" ? "compute" : "container")
    : run.workerQueue;
}
