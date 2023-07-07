import type { DynamicTriggerEndpointMetadata } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";

export class RegisterDynamicTriggerService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    endpointIdOrEndpoint: string | ExtendedEndpoint,
    metadata: DynamicTriggerEndpointMetadata
  ) {
    const endpoint =
      typeof endpointIdOrEndpoint === "string"
        ? await findEndpoint(endpointIdOrEndpoint)
        : endpointIdOrEndpoint;

    const dynamicTrigger = await this.#prismaClient.dynamicTrigger.upsert({
      where: {
        endpointId_slug_type: {
          endpointId: endpoint.id,
          slug: metadata.id,
          type: "EVENT",
        },
      },
      create: {
        slug: metadata.id,
        type: "EVENT",
        endpoint: {
          connect: {
            id: endpoint.id,
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
            endpointId: endpoint.id,
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
