import { ApiEventLogSchema } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ClientApi } from "../clientApi.server";

export class DeliverEventService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const eventLog = await this.#prismaClient.eventLog.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        environment: true,
        organization: true,
      },
    });

    const endpoint = await this.#prismaClient.endpoint.findFirstOrThrow({
      where: {
        organizationId: eventLog.organizationId,
        environmentId: eventLog.environmentId,
      },
    });

    const apiEventLog = ApiEventLogSchema.parse(eventLog);

    const client = new ClientApi(eventLog.environment.apiKey, endpoint.url);

    await client.deliverEvent(apiEventLog);

    await this.#prismaClient.eventLog.update({
      where: {
        id: eventLog.id,
      },
      data: {
        deliveredAt: new Date(),
      },
    });
  }
}
