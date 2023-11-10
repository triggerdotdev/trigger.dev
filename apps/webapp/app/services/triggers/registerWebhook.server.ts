import { WebhookMetadata } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";

export class RegisterWebhookService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    endpointIdOrEndpoint: string | ExtendedEndpoint,
    webhookMetadata: WebhookMetadata
  ) {
    const endpoint =
      typeof endpointIdOrEndpoint === "string"
        ? await findEndpoint(endpointIdOrEndpoint)
        : endpointIdOrEndpoint;

    return await $transaction(this.#prismaClient, async (tx) => {
      const webhook = await tx.webhook.upsert({
        where: {
          key_projectId: {
            key: webhookMetadata.key,
            projectId: endpoint.projectId,
          },
        },
        create: {
          key: webhookMetadata.key,
          params: webhookMetadata.params,
          desiredConfig: webhookMetadata.config,
          httpEndpoint: {
            connect: {
              key_projectId: {
                key: webhookMetadata.httpEndpoint.id,
                projectId: endpoint.projectId,
              },
            },
          },
          project: {
            connect: {
              id: endpoint.projectId,
            },
          },
          integration: {
            connect: {
              organizationId_slug: {
                organizationId: endpoint.organizationId,
                slug: webhookMetadata.integration.id,
              },
            },
          },
        },
        update: {
          key: webhookMetadata.key,
          params: webhookMetadata.params,
          desiredConfig: webhookMetadata.config,
        },
      });

      // TODO: enqueue webhook activation

      return webhook;
    });
  }
}
