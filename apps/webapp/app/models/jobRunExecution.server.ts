import { JobRun, JobRunExecution } from "@trigger.dev/database";
import { PrismaClientOrTransaction } from "~/db.server";
import { executionWorker } from "~/services/worker.server";

export type EnqueueRunExecutionV2Options = {
  runAt?: Date;
  resumeTaskId?: string;
  isRetry?: boolean;
  skipRetrying?: boolean;
  executionCount?: number;
};

export async function enqueueRunExecutionV2(
  run: JobRun,
  tx: PrismaClientOrTransaction,
  options: EnqueueRunExecutionV2Options = {}
) {
  const job = await executionWorker.enqueue(
    "performRunExecutionV2",
    {
      id: run.id,
      reason: run.status === "PREPROCESSING" ? "PREPROCESS" : "EXECUTE_JOB",
      resumeTaskId: options.resumeTaskId,
      isRetry: typeof options.isRetry === "boolean" ? options.isRetry : false,
    },
    {
      tx,
      runAt: options.runAt,
      jobKey: `job_run:${run.id}:${options.executionCount ?? 0}${
        options.resumeTaskId ? `:task:${options.resumeTaskId}` : ""
      }`,
      maxAttempts: options.skipRetrying ? 1 : undefined,
    }
  );
}

export async function dequeueRunExecutionV2(run: JobRun, tx: PrismaClientOrTransaction) {
  return await executionWorker.dequeue(`job_run:${run.id}`, {
    tx,
  });
}
