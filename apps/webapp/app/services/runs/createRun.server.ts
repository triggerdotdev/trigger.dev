import type { Job, JobInstance } from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";

export class CreateRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    eventId,
    job,
    jobInstance,
  }: {
    environment: AuthenticatedEnvironment;
    eventId: string;
    job: Job;
    jobInstance: JobInstance;
  }) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        id: jobInstance.endpointId,
      },
    });

    const execution = await this.#prismaClient.$transaction(async (prisma) => {
      // Get the current max number for the given jobId
      const currentMaxNumber = await prisma.jobRun.aggregate({
        where: { jobId: job.id },
        _max: { number: true },
      });

      // Increment the number for the new execution
      const newNumber = (currentMaxNumber._max.number ?? 0) + 1;

      // Create the new execution with the incremented number
      return prisma.jobRun.create({
        data: {
          number: newNumber,
          job: { connect: { id: job.id } },
          jobInstance: { connect: { id: jobInstance.id } },
          eventLog: { connect: { id: eventId } },
          environment: { connect: { id: environment.id } },
          organization: { connect: { id: environment.organizationId } },
          project: { connect: { id: environment.projectId } },
          endpoint: { connect: { id: endpoint.id } },
        },
      });
    });

    await workerQueue.enqueue("startRun", {
      id: execution.id,
    });

    return execution;
  }
}
