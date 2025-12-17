import { TaskRunError, TaskRunErrorCodes } from "@trigger.dev/core/v3/schemas";
import { TaskRun } from "@trigger.dev/database";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { marqs } from "../marqs/index.server";

export type EnqueueRunOptions = {
  env: AuthenticatedEnvironment;
  run: TaskRun;
  dependentRun?: { queue: string; id: string };
  rateLimitKey?: string;
};

export type EnqueueRunResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: TaskRunError;
    };

export async function enqueueRun({
  env,
  run,
  dependentRun,
  rateLimitKey,
}: EnqueueRunOptions): Promise<EnqueueRunResult> {
  // If this is a triggerAndWait or batchTriggerAndWait,
  // we need to add the parent run to the reserve concurrency set
  // to free up concurrency for the children to run
  // In the case of a recursive queue, reserving concurrency can fail, which means there is a deadlock and we need to fail the run

  // TODO: reserveConcurrency can fail because of a deadlock, we need to handle that case
  const wasEnqueued = await marqs.enqueueMessage(
    env,
    run.queue,
    run.id,
    {
      type: "EXECUTE",
      taskIdentifier: run.taskIdentifier,
      projectId: env.projectId,
      environmentId: env.id,
      environmentType: env.type,
      // Include rateLimitKey in message payload for dequeue-time checks
      rateLimitKey,
    },
    run.concurrencyKey ?? undefined,
    run.queueTimestamp ?? undefined,
    dependentRun
      ? { messageId: dependentRun.id, recursiveQueue: dependentRun.queue === run.queue }
      : undefined
  );

  if (!wasEnqueued) {
    const error = {
      type: "INTERNAL_ERROR",
      code: TaskRunErrorCodes.RECURSIVE_WAIT_DEADLOCK,
      message: `This run will never execute because it was triggered recursively and the task has no remaining concurrency available`,
    } satisfies TaskRunError;

    return {
      ok: false,
      error,
    };
  }

  return {
    ok: true,
  };
}
