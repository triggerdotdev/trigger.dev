import {
  RegisterDynamicSchedulePayload,
  SCHEDULED_EVENT,
} from "@trigger.dev/internal";
import { PrismaClientOrTransaction, prisma } from "~/db.server";

export class RegisterDynamicScheduleService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    endpointId: string,
    metadata: RegisterDynamicSchedulePayload
  ) {
    const dynamicTrigger = await this.#prismaClient.dynamicTrigger.upsert({
      where: {
        endpointId_slug_type: {
          endpointId: endpointId,
          slug: metadata.id,
          type: "SCHEDULE",
        },
      },
      create: {
        slug: metadata.id,
        type: "SCHEDULE",
        endpoint: {
          connect: {
            id: endpointId,
          },
        },
      },
      update: {},
      include: {
        jobs: true,
        endpoint: true,
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

    await this.#prismaClient.eventDispatcher.upsert({
      where: {
        dispatchableId_environmentId: {
          dispatchableId: dynamicTrigger.id,
          environmentId: dynamicTrigger.endpoint.environmentId,
        },
      },
      create: {
        event: SCHEDULED_EVENT,
        source: "trigger.dev",
        payloadFilter: {},
        contextFilter: {},
        environmentId: dynamicTrigger.endpoint.environmentId,
        enabled: true,
        dispatchable: {
          type: "DYNAMIC_TRIGGER",
          id: dynamicTrigger.id,
        },
        dispatchableId: dynamicTrigger.id,
        manual: true,
      },
      update: {
        dispatchable: {
          type: "DYNAMIC_TRIGGER",
          id: dynamicTrigger.id,
        },
      },
    });
  }
}
