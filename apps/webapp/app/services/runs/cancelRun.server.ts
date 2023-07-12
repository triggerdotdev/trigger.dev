import { PrismaClient, prisma } from "~/db.server";
import { workerQueue } from "../worker.server";

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

        const shouldDecrementQueue =
          run.status === "STARTED" || run.status === "PREPROCESSING";
        await tx.jobRun.update({
          where: { id: runId },
          data: {
            status: "CANCELED",
            completedAt: new Date(),
            queue: shouldDecrementQueue
              ? {
                  update: {
                    jobCount: {
                      decrement: 1,
                    },
                  },
                }
              : undefined,
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

        await workerQueue.enqueue(
          "startQueuedRuns",
          {
            id: run.queueId,
          },
          { tx }
        );
      });
    } catch (error) {
      throw error;
    }
  }
}
