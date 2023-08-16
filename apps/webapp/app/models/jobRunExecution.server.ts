import { JobRun, JobRunExecution } from "@trigger.dev/database";
import { PrismaClientOrTransaction } from "~/db.server";
import { queueRoundRobin } from "~/services/runs/queuedRoundRobinStorage.server";
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
      queueName: `job:queue:${queueId}:${await queueRoundRobin.next(queueId, concurrency)}`,
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
  queueId: string,
  concurrency: number,
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
      queueName: `job:queue:${queueId}:${await queueRoundRobin.next(queueId, concurrency)}`,
      tx,
      runAt: options.runAt,
      jobKey: `execution:${run.id}`,
    }
  );
}

export async function dequeueRunExecutionV2(run: JobRun, tx: PrismaClientOrTransaction) {
  return await executionWorker.dequeue(`execution:${run.id}`, {
    tx,
  });
}
