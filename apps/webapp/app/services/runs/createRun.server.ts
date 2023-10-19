import type { Job, JobVersion } from "@trigger.dev/database";
import { $transaction, PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";
import { logger } from "../logger.server";

export class CreateRunService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    job,
    version,
    eventIds,
    isBatched = false,
  }: {
    environment: AuthenticatedEnvironment;
    job: Job;
    version: JobVersion;
    eventIds: string[];
    isBatched?: boolean;
  }) {
    if (!eventIds.length) {
      return;
    }

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

    const eventRecords = await this.#prismaClient.eventRecord.findMany({
      where: {
        id: { in: eventIds },
      },
    });

    if (!eventRecords.length) {
      throw new Error("No event records found.");
    }

    if (eventRecords.length !== eventIds.length) {
      logger.warn("Event record counts do not match", {
        expected: eventIds.length,
        found: eventRecords.length,
      });
    }

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

      const firstEvent = eventRecords[0];

      // Create the new execution with the incremented number
      const run = await tx.jobRun.create({
        data: {
          number: newNumber,
          preprocess: version.preprocessRuns,
          jobId: job.id,
          versionId: version.id,
          eventId: firstEvent.id,
          eventIds: eventRecords.map((event) => event.id),
          environmentId: environment.id,
          organizationId: environment.organizationId,
          payload: isBatched
            ? eventRecords.map((event) => event.payload) ?? [{}]
            : firstEvent.payload ?? {},
          projectId: environment.projectId,
          endpointId: endpoint.id,
          queueId: jobQueue.id,
          externalAccountId: firstEvent.externalAccountId
            ? firstEvent.externalAccountId
            : undefined,
          isTest: firstEvent.isTest,
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
