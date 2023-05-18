import type { DynamicTriggerEndpointMetadata } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export class RegisterDynamicTriggerService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    endpointId: string,
    metadata: DynamicTriggerEndpointMetadata
  ) {
    const dynamicTrigger = await this.#prismaClient.dynamicTrigger.upsert({
      where: {
        endpointId_slug: {
          endpointId: endpointId,
          slug: metadata.id,
        },
      },
      create: {
        slug: metadata.id,
        endpoint: {
          connect: {
            id: endpointId,
          },
        },
      },
      update: {},
      include: {
        jobs: true,
      },
    });

    // Now we need to connect the jobs
    const jobs = await this.#prismaClient.job.findMany({
      where: {
        slug: {
          in: metadata.jobs.map((job) => job.id),
        },
        versions: {
          some: {
            endpointId,
          },
        },
      },
    });

    // Update all the jobs that are associated with this dynamic trigger
    await this.#prismaClient.dynamicTrigger.update({
      where: {
        id: dynamicTrigger.id,
      },
      data: {
        jobs: {
          connect: jobs.map((job) => ({
            id: job.id,
          })),
          disconnect: dynamicTrigger.jobs.filter(
            (job) => !jobs.find((j) => j.id === job.id)
          ),
        },
      },
    });
  }
}
