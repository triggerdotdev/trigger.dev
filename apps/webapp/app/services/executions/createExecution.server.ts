import type {
  EventLog,
  Job,
  JobInstance,
  Organization,
  RuntimeEnvironment,
} from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "~/services/worker.server";

export class CreateExecutionService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    eventId,
    organization,
    job,
    jobInstance,
  }: {
    environment: RuntimeEnvironment;
    organization: Organization;
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
      const currentMaxNumber = await prisma.execution.aggregate({
        where: { jobId: job.id },
        _max: { number: true },
      });

      // Increment the number for the new execution
      const newNumber = (currentMaxNumber._max.number ?? 0) + 1;

      // Create the new execution with the incremented number
      return prisma.execution.create({
        data: {
          number: newNumber,
          job: { connect: { id: job.id } },
          jobInstance: { connect: { id: jobInstance.id } },
          eventLog: { connect: { id: eventId } },
          environment: { connect: { id: environment.id } },
          organization: { connect: { id: organization.id } },
          endpoint: { connect: { id: endpoint.id } },
        },
      });
    });

    await workerQueue.enqueue("startExecution", {
      id: execution.id,
    });

    return execution;
  }
}
