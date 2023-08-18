import { JobRun, JobRunExecution } from "@trigger.dev/database";
import { PrismaClientOrTransaction } from "~/db.server";
import { executionWorker } from "~/services/worker.server";

export async function enqueueRunExecutionV1(
  execution: JobRunExecution,
  queueId: string,
  concurrency: number,
  tx: PrismaClientOrTransaction,
  runAt?: Date
) {
  const job = await executionWorker.enqueue(
    "performRunExecution",
    {
      id: execution.id,
    },
    {
      queueName: `job:queue:${queueId}`,
      tx,
      runAt,
      jobKey: `execution:${execution.runId}`,
    }
  );
}

export type EnqueueRunExecutionV2Options = {
  runAt?: Date;
  resumeTaskId?: string;
  isRetry?: boolean;
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
      queueName: `job:${run.jobId}:env:${run.environmentId}`,
      tx,
      runAt: options.runAt,
      jobKey: `job_run:${run.id}`,
    }
  );
}

export async function dequeueRunExecutionV2(run: JobRun, tx: PrismaClientOrTransaction) {
  return await executionWorker.dequeue(`job_run:${run.id}`, {
    tx,
  });
}
