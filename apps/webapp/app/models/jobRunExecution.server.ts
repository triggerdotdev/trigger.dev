import { JobRunExecution } from "@trigger.dev/database";
import { PrismaClientOrTransaction } from "~/db.server";
import { queueRoundRobin } from "~/services/runs/queuedRoundRobinStorage.server";
import { executionWorker } from "~/services/worker.server";

export async function enqueueRunExecution(
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
