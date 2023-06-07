import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { EndpointApi } from "../endpointApi";
import { IngestSendEvent } from "../events/ingestSendEvent.server";
import { getSecretStore } from "../secrets/secretStore.server";

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
              secretReference: true,
              dynamicTrigger: true,
              externalAccount: true,
            },
          },
        },
      });

    if (!httpSourceRequest.source.active) {
      return;
    }

    const secretStore = getSecretStore(
      httpSourceRequest.source.secretReference.provider
    );

    const secret = await secretStore.getSecret(
      z.object({
        secret: z.string(),
      }),
      httpSourceRequest.source.secretReference.key
    );

    if (!secret) {
      throw new Error(`Secret not found for ${httpSourceRequest.source.key}`);
    }

    // TODO: implement auth for http source requests

    const clientApi = new EndpointApi(
      httpSourceRequest.environment.apiKey,
      httpSourceRequest.endpoint.url
    );

    const { response, events } = await clientApi.deliverHttpSourceRequest({
      key: httpSourceRequest.source.key,
      dynamicId: httpSourceRequest.source.dynamicTrigger?.slug,
      secret: secret.secret,
      params: httpSourceRequest.source.params,
      data: httpSourceRequest.source.channelData,
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
      await ingestService.call(httpSourceRequest.environment, event, {
        accountId: httpSourceRequest.source.externalAccount?.identifier,
      });
    }

    return response;
  }
}
