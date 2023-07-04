import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "../worker.server";

export class StartQueuedRunsService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const queue = await this.#prismaClient.jobQueue.findUnique({
      where: { id },
      include: {
        runs: {
          where: {
            status: "QUEUED",
          },
          orderBy: {
            queuedAt: "asc",
          },
          take: 1,
        },
      },
    });

    if (!queue) {
      return;
    }

    if (queue.runs.length === 0) {
      return;
    }

    if (queue.jobCount >= queue.maxJobs) {
      return;
    }

    const run = queue.runs[0];

    if (!run) {
      return;
    }

    await workerQueue.enqueue(
      "startRun",
      {
        id: run.id,
      },
      {
        queueName: `job-queue:${queue.id}`,
      }
    );
  }
}
