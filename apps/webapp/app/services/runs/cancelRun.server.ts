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
        const run = await tx.jobRun.update({
          select: {
            queueId: true,
          },
          where: { id: runId },
          data: {
            status: "CANCELED",
            queue: {
              update: {
                jobCount: {
                  decrement: 1,
                },
              },
            },
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
