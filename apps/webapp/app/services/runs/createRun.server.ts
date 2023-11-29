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

  public async call(
    {
      environment,
      eventIds,
      job,
      version,
    }: {
      environment: AuthenticatedEnvironment;
      eventIds: string[];
      job: Job;
      version: JobVersion;
    },
    options: { callbackUrl?: string } = {}
  ) {
    if (!eventIds.length) {
      throw new Error("No event IDs provided.");
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

    const firstEvent = eventRecords[0];

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
          eventId: firstEvent.id,
          environmentId: environment.id,
          organizationId: environment.organizationId,
          projectId: environment.projectId,
          endpointId: endpoint.id,
          queueId: jobQueue.id,
          payload: JSON.stringify(
            eventRecords.length > 1
              ? eventRecords.map((event) => event.payload) ?? [{}]
              : firstEvent.payload ?? {}
          ),
          externalAccountId: firstEvent.externalAccountId
            ? firstEvent.externalAccountId
            : undefined,
          isTest: firstEvent.isTest,
          internal: job.internal,
        },
      });

      if (options.callbackUrl) {
        await tx.jobRunSubscription.createMany({
          data: [
            {
              runId: run.id,
              recipientMethod: "WEBHOOK",
              recipient: options.callbackUrl,
              event: "SUCCESS",
            },
            {
              runId: run.id,
              recipientMethod: "WEBHOOK",
              recipient: options.callbackUrl,
              event: "FAILURE",
            },
          ],
        });
      }

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
