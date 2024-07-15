import { z } from "zod";
import { prisma ,type  PrismaClient  } from "~/db.server";
import { EndpointApi } from "../endpointApi.server";
import { getSecretStore } from "../secrets/secretStore.server";

export class DeliverWebhookRequestService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const requestDelivery = await this.#prismaClient.webhookRequestDelivery.findUniqueOrThrow({
      where: {
        id,
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
        webhookEnvironment: {
          include: {
            environment: {
              include: {
                organization: true,
                project: true,
              },
            },
          },
        },
        endpoint: true,
      },
    });

    if (!requestDelivery.webhookEnvironment.active) {
      return;
    }

    if (!requestDelivery.endpoint.url) {
      return;
    }

    const { secretReference } = requestDelivery.webhook.httpEndpoint;

    const secretStore = getSecretStore(secretReference.provider);

    const secret = await secretStore.getSecret(
      z.object({
        secret: z.string(),
      }),
      secretReference.key
    );

    if (!secret) {
      throw new Error(`Secret not found for ${requestDelivery.webhook.key}`);
    }

    const clientApi = new EndpointApi(
      requestDelivery.webhookEnvironment.environment.apiKey,
      requestDelivery.endpoint.url
    );

    const { response, verified, error } = await clientApi.deliverWebhookRequest({
      key: requestDelivery.webhook.key,
      secret: secret.secret,
      params: requestDelivery.webhook.params,
      request: {
        url: requestDelivery.url,
        method: requestDelivery.method,
        headers: requestDelivery.headers as Record<string, string>,
        rawBody: requestDelivery.body,
      },
    });

    await this.#prismaClient.webhookRequestDelivery.update({
      where: {
        id,
      },
      data: {
        deliveredAt: new Date(),
        verified,
        error,
      },
    });

    return response;
  }
}
