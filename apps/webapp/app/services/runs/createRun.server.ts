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
      batched,
    }: {
      environment: AuthenticatedEnvironment;
      eventIds: string[];
      job: Job;
      version: JobVersion;
      batched: boolean;
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

    const eventRecords = await this.#prismaClient.eventRecord.findMany({
      where: {
        environmentId: environment.id,
        eventId: { in: eventIds },
      },
    });

    if (!eventRecords.length) {
      throw new Error("No event records found.");
    }

    const firstEvent = eventRecords[0];

    return await $transaction(this.#prismaClient, async (tx) => {
      const run = await tx.jobRun.create({
        data: {
          preprocess: version.preprocessRuns,
          jobId: job.id,
          versionId: version.id,
          eventId: firstEvent.id,
          eventIds: eventRecords.map((event) => event.eventId),
          environmentId: environment.id,
          organizationId: environment.organizationId,
          projectId: environment.projectId,
          endpointId: endpoint.id,
          batched,
          payload: JSON.stringify(
            batched ? eventRecords.map((event) => event.payload) ?? [{}] : firstEvent.payload ?? {}
          ),
          context: JSON.stringify(
            batched ? eventRecords.map((event) => event.context) ?? [{}] : firstEvent.context ?? {}
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
