import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { IngestSendEvent } from "~/routes/api.v3.events";

export class DeliverHttpSourceRequestService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const httpSourceRequest =
      await this.#prismaClient.httpSourceRequestDelivery.findUniqueOrThrow({
        where: { id },
        include: {
          endpoint: true,
          environment: {
            include: {
              organization: true,
              project: true,
            },
          },
          source: {
            include: {
              connection: true,
            },
          },
        },
      });

    if (!httpSourceRequest.source.active) {
      return;
    }

    const service = new IngestSendEvent();

    await service.call(httpSourceRequest.environment, {
      id: httpSourceRequest.id,
      name: "internal.trigger.handle-raw-source-event",
      source: "trigger.dev",
      payload: {
        source: {
          key: httpSourceRequest.source.key,
          secret: httpSourceRequest.source.secret,
          data: httpSourceRequest.source.data as any,
        },
        rawEvent: {
          url: httpSourceRequest.url,
          method: httpSourceRequest.method,
          headers: httpSourceRequest.headers as any,
          // Convert httpSourceRequest.body from a Buffer to a string
          rawBody: httpSourceRequest.body
            ? httpSourceRequest.body.toString("utf-8")
            : null,
        },
      },
    });
  }
}
