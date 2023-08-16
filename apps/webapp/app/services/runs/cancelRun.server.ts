import { PrismaClient, prisma } from "~/db.server";
import { executionWorker } from "../worker.server";
import { dequeueRunExecutionV2 } from "~/models/jobRunExecution.server";

export class CancelRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ runId }: { runId: string }) {
    try {
      return await this.#prismaClient.$transaction(async (tx) => {
        const run = await tx.jobRun.findUniqueOrThrow({
          where: {
            id: runId,
          },
        });

        await tx.jobRun.update({
          where: { id: runId },
          data: {
            status: "CANCELED",
            completedAt: new Date(),
          },
        });

        await tx.task.updateMany({
          where: {
            runId,
            status: {
              in: ["PENDING", "RUNNING", "WAITING"],
            },
          },
          data: {
            status: "CANCELED",
            completedAt: new Date(),
          },
        });

        await dequeueRunExecutionV2(run, tx);
      });
    } catch (error) {
      throw error;
    }
  }
}
