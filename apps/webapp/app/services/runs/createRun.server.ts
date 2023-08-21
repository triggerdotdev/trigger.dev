import type { Job, JobVersion } from "@trigger.dev/database";
import { $transaction, PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";

export class CreateRunService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    eventId,
    job,
    version,
  }: {
    environment: AuthenticatedEnvironment;
    eventId: string;
    job: Job;
    version: JobVersion;
  }) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        id: version.endpointId,
      },
    });

    const jobQueue = await this.#prismaClient.jobQueue.findUniqueOrThrow({
      where: {
        id: version.queueId,
      },
    });

    const eventRecord = await this.#prismaClient.eventRecord.findUniqueOrThrow({
      where: {
        id: eventId,
      },
    });

    return await $transaction(this.#prismaClient, async (tx) => {
      // Get the current max number for the given jobId
      const currentMaxNumber = await tx.jobRun.aggregate({
        where: { jobId: job.id },
        _max: { number: true },
      });

      // Increment the number for the new execution
      const newNumber = (currentMaxNumber._max.number ?? 0) + 1;

      // Create the new execution with the incremented number
      const run = await tx.jobRun.create({
        data: {
          number: newNumber,
          preprocess: version.preprocessRuns,
          job: { connect: { id: job.id } },
          version: { connect: { id: version.id } },
          event: { connect: { id: eventId } },
          environment: { connect: { id: environment.id } },
          organization: { connect: { id: environment.organizationId } },
          project: { connect: { id: environment.projectId } },
          endpoint: { connect: { id: endpoint.id } },
          queue: { connect: { id: jobQueue.id } },
          externalAccount: eventRecord.externalAccountId
            ? { connect: { id: eventRecord.externalAccountId } }
            : undefined,
          isTest: eventRecord.isTest,
        },
      });

      await workerQueue.enqueue(
        "startRun",
        {
          id: run.id,
        },
        { tx }
      );

      return run;
    });
  }
}
