import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ClientApi } from "../clientApi.server";
import {
  SecretStoreProvider,
  getSecretStore,
} from "../secrets/secretStore.server";
import { SecretStore } from "../secrets/secretStore.server";
import { z } from "zod";
import { IngestSendEvent } from "../events/ingestSendEvent.server";

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

    const clientApi = new ClientApi(
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
      await ingestService.call(httpSourceRequest.environment, event);
    }

    return response;
  }
}
