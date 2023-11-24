import { JobRun } from "@trigger.dev/database";
import { PrismaClientOrTransaction } from "~/db.server";
import { executionWorker } from "~/services/worker.server";

export async function dequeueRunExecutionV2(run: JobRun, tx: PrismaClientOrTransaction) {
  return await executionWorker.dequeue(`job_run:${run.id}`, {
    tx,
  });
}

export type EnqueueRunExecutionV3Options = {
  runAt?: Date;
  skipRetrying?: boolean;
};

export async function enqueueRunExecutionV3(
  run: JobRun,
  tx: PrismaClientOrTransaction,
  options: EnqueueRunExecutionV3Options = {}
) {
  const reason = run.status === "PREPROCESSING" ? "PREPROCESS" : "EXECUTE_JOB";

  return await executionWorker.enqueue(
    "performRunExecutionV3",
    {
      id: run.id,
      reason: reason,
    },
    {
      tx,
      runAt: options.runAt,
      queueName: `job_run:${run.id}`,
      jobKey: `job_run:${reason}:${run.id}`,
      maxAttempts: options.skipRetrying ? 1 : undefined,
    }
  );
}

export async function dequeueRunExecutionV3(run: JobRun, tx: PrismaClientOrTransaction) {
  await executionWorker.dequeue(`job_run:EXECUTE_JOB:${run.id}`, {
    tx,
  });

  await executionWorker.dequeue(`job_run:PREPROCESS:${run.id}`, {
    tx,
  });
}
