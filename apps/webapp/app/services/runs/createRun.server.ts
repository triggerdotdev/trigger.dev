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
      const latestJob = await tx.jobRun.findFirst({
        where: { jobId: job.id },
        orderBy: { id: "desc" },
        select: {
          number: true,
        },
      });

      // Increment the number for the new execution
      const newNumber = (latestJob?.number ?? 0) + 1;

      // Create the new execution with the incremented number
      const run = await tx.jobRun.create({
        data: {
          number: newNumber,
          preprocess: version.preprocessRuns,
          jobId: job.id,
          versionId: version.id,
          eventId: eventId,
          environmentId: environment.id,
          organizationId: environment.organizationId,
          projectId: environment.projectId,
          endpointId: endpoint.id,
          queueId: jobQueue.id,
          externalAccountId: eventRecord.externalAccountId
            ? eventRecord.externalAccountId
            : undefined,
          isTest: eventRecord.isTest,
          internal: job.internal,
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
