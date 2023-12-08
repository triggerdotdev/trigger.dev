import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { EndpointApi, WebhookRequest } from "../endpointApi.server";
import { getSecretStore } from "../secrets/secretStore.server";
import { WebhookRequestDelivery } from "@trigger.dev/database";

export class DeliverWebhookRequestService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(webhookEnvironmentId: string, requestDeliveryIds: string[]) {
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
        deliveryBatcher: true,
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

    if (requestDeliveries.length > 1 && !webhookEnvironment.deliveryBatcher) {
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

    const context = {
      key: webhookEnvironment.webhook.key,
      secret: secret.secret,
      params: webhookEnvironment.webhook.params,
    };

    if (webhookEnvironment.deliveryBatcher) {
      const { response, deliveryResults } = await clientApi.deliverBatchedWebhookRequests({
        ...context,
        requests: requestDeliveries.map(this.#buildWebhookRequest),
      });

      const deliveredAt = new Date();

      await Promise.allSettled(
        deliveryResults.map((result, i) =>
          this.#completeWebhookRequestDelivery(requestDeliveries[i].id, result, deliveredAt)
        )
      );

      return response;
    } else {
      const delivery = requestDeliveries[0];

      const { response, verified, error } = await clientApi.deliverWebhookRequest({
        ...context,
        request: this.#buildWebhookRequest(delivery),
      });

      await this.#completeWebhookRequestDelivery(delivery.id, { verified, error });

      return response;
    }
  }

  #buildWebhookRequest(delivery: WebhookRequestDelivery): WebhookRequest {
    return {
      url: delivery.url,
      method: delivery.method,
      headers: delivery.headers as Record<string, string>,
      rawBody: delivery.body,
    };
  }

  async #completeWebhookRequestDelivery(
    id: string,
    result: { verified: boolean; error?: string },
    deliveredAt = new Date()
  ) {
    return await this.#prismaClient.webhookRequestDelivery.update({
      where: {
        id,
      },
      data: {
        ...result,
        deliveredAt,
      },
    });
  }
}
