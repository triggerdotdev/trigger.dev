import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "../worker.server";

export class PrepareForJobExecutionService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        jobInstances: true,
      },
    });

    for (const jobInstance of endpoint.jobInstances) {
      if (jobInstance.ready) {
        continue;
      }

      await workerQueue.enqueue(
        "prepareJobInstance",
        { id: jobInstance.id },
        { queueName: `endpoint-${endpoint.id}` }
      );
    }
  }
}
