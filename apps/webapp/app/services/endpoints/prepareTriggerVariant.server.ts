import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { resolveJobConnection } from "~/models/jobConnection.server";
import { ClientApi } from "../clientApi.server";

export class PrepareTriggerVariantService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const triggerVariant =
      await this.#prismaClient.jobTriggerVariant.findUniqueOrThrow({
        where: {
          id,
        },
        include: {
          jobInstance: {
            include: {
              job: true,
              endpoint: {
                include: {
                  environment: true,
                },
              },
              triggerVariants: true,
            },
          },
        },
      });

    const jobInstance = triggerVariant.jobInstance;

    const client = new ClientApi(
      jobInstance.endpoint.environment.apiKey,
      jobInstance.endpoint.url
    );

    const connection = await this.#prismaClient.jobConnection.findUnique({
      where: {
        jobInstanceId_key: {
          jobInstanceId: jobInstance.id,
          key: `__trigger_${triggerVariant.slug}`,
        },
      },
      include: {
        apiConnection: {
          include: {
            dataReference: true,
          },
        },
      },
    });

    const response = await client.prepareJobTrigger({
      id: jobInstance.job.slug,
      version: jobInstance.version,
      connection: connection
        ? await resolveJobConnection(connection)
        : undefined,
      variantId: triggerVariant.slug,
    });

    if (!response.ok) {
      throw new Error("Something went wrong when preparing a trigger variant");
    }

    await this.#prismaClient.jobTriggerVariant.update({
      where: {
        id,
      },
      data: {
        ready: true,
      },
    });
  }
}
