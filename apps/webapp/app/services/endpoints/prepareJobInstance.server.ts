import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { resolveJobConnection } from "~/models/jobConnection.server";
import { ClientApi } from "../clientApi.server";
import { workerQueue } from "../worker.server";

export class PrepareJobInstanceService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const jobInstance = await this.#prismaClient.jobInstance.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        connections: {
          include: {
            apiConnection: {
              include: {
                dataReference: true,
              },
            },
          },
          where: {
            key: "__trigger",
          },
        },
        job: true,
        endpoint: {
          include: {
            environment: true,
          },
        },
        triggerVariants: true,
      },
    });

    const client = new ClientApi(
      jobInstance.endpoint.environment.apiKey,
      jobInstance.endpoint.url
    );

    const connection = jobInstance.connections[0];

    const response = await client.prepareJobTrigger({
      id: jobInstance.job.slug,
      version: jobInstance.version,
      connection: connection
        ? await resolveJobConnection(connection)
        : undefined,
    });

    if (!response.ok) {
      throw new Error("Something went wrong when preparing a job instance");
    }

    await this.#prismaClient.jobInstance.update({
      where: {
        id,
      },
      data: {
        ready: true,
      },
    });

    for (const variant of jobInstance.triggerVariants) {
      if (variant.ready) {
        continue;
      }

      await workerQueue.enqueue(
        "prepareTriggerVariant",
        {
          id: variant.id,
        },
        {
          queueName: `endpoint-${jobInstance.endpoint.id}`,
        }
      );
    }
  }
}
