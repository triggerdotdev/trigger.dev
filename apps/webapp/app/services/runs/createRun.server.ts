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
      eventId,
      job,
      version,
    }: {
      environment: AuthenticatedEnvironment;
      eventId: string;
      job: Job;
      version: JobVersion;
    },
    options: { callbackUrl?: string } = {}
  ) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        id: version.endpointId,
      },
    });

    const eventRecord = await this.#prismaClient.eventRecord.findUniqueOrThrow({
      where: {
        id: eventId,
      },
    });

    return await $transaction(this.#prismaClient, async (tx) => {
      const run = await tx.jobRun.create({
        data: {
          preprocess: version.preprocessRuns,
          jobId: job.id,
          versionId: version.id,
          eventId: eventId,
          environmentId: environment.id,
          organizationId: environment.organizationId,
          projectId: environment.projectId,
          endpointId: endpoint.id,
          externalAccountId: eventRecord.externalAccountId
            ? eventRecord.externalAccountId
            : undefined,
          isTest: eventRecord.isTest,
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
