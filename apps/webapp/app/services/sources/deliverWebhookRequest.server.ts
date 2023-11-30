import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { EndpointApi } from "../endpointApi.server";
import { getSecretStore } from "../secrets/secretStore.server";

export class DeliverWebhookRequestService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(webhookEnvironmentId: string, requestDeliveryIds: string[], batched = false) {
    const webhookEnvironment = await this.#prismaClient.webhookEnvironment.findUniqueOrThrow({
      where: {
        id: webhookEnvironmentId,
      },
      include: {
        webhook: {
          include: {
            integration: {
              include: {
                connections: true,
              },
            },
            httpEndpoint: {
              include: {
                secretReference: true,
              },
            },
          },
        },
        environment: {
          include: {
            organization: true,
            project: true,
          },
        },
        endpoint: true,
      },
    });

    if (!webhookEnvironment.active) {
      return;
    }

    const requestDeliveries = await this.#prismaClient.webhookRequestDelivery.findMany({
      where: {
        id: { in: requestDeliveryIds },
      },
      include: {
        endpoint: true,
      },
    });

    if (!requestDeliveries.length) {
      throw new Error(`No request deliveries found, expected ${requestDeliveryIds.length} total.`);
    }

    if (!batched && requestDeliveries.length > 1) {
      throw new Error(
        `Batching is disabled. Will not handle multiple deliveries. Requested ${requestDeliveryIds.length} total.`
      );
    }

    const { secretReference } = webhookEnvironment.webhook.httpEndpoint;

    const secretStore = getSecretStore(secretReference.provider);

    const secret = await secretStore.getSecret(
      z.object({
        secret: z.string(),
      }),
      secretReference.key
    );

    if (!secret) {
      throw new Error(`Secret not found for ${webhookEnvironment.webhook.key}`);
    }

    const clientApi = new EndpointApi(
      webhookEnvironment.environment.apiKey,
      requestDeliveries[0].endpoint.url
    );

    const requests = requestDeliveries.map((delivery) => ({
      url: delivery.url,
      method: delivery.method,
      headers: delivery.headers as Record<string, string>,
      rawBody: delivery.body,
    }));

    const { response, deliveryResults } = await clientApi.deliverWebhookRequests({
      key: webhookEnvironment.webhook.key,
      secret: secret.secret,
      params: webhookEnvironment.webhook.params,
      requests,
      batched,
    });

    const deliveredAt = new Date();

    await Promise.allSettled(
      deliveryResults.map((result, i) => {
        return this.#prismaClient.webhookRequestDelivery.update({
          where: {
            id: requestDeliveries[i].id,
          },
          data: {
            ...result,
            deliveredAt,
          },
        });
      })
    );

    return response;
  }
}
