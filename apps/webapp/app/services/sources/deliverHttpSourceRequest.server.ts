import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { IngestSendEvent } from "~/routes/api/v3/events";
import { ClientApi } from "../clientApi.server";
import { getConnectionAuth } from "../connectionAuth.server";

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

    const auth = await getConnectionAuth(httpSourceRequest.source.connection);

    const clientApi = new ClientApi(
      httpSourceRequest.environment.apiKey,
      httpSourceRequest.endpoint.url
    );

    const { response, events } = await clientApi.deliverHttpSourceRequest({
      key: httpSourceRequest.source.key,
      secret: httpSourceRequest.source.secret ?? undefined,
      auth,
      request: {
        url: httpSourceRequest.url,
        method: httpSourceRequest.method,
        headers: httpSourceRequest.headers as Record<string, string>,
        rawBody: httpSourceRequest.body,
      },
    });

    await this.#prismaClient.httpSourceRequestDelivery.update({
      where: {
        id,
      },
      data: {
        deliveredAt: new Date(),
      },
    });

    const ingestService = new IngestSendEvent();

    for (const event of events) {
      await ingestService.call(httpSourceRequest.environment, event);
    }

    return response;
  }
}
