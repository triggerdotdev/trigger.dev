import { REGISTER_WEBHOOK, WebhookMetadata } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";
import { IngestSendEvent } from "../events/ingestSendEvent.server";
import { Prisma } from "@trigger.dev/database";
import { ulid } from "../ulid.server";
import { getSecretStore } from "../secrets/secretStore.server";
import { z } from "zod";
import { httpEndpointUrl } from "../httpendpoint/HandleHttpEndpointService";

type ExtendedWebhook = Prisma.WebhookGetPayload<{
  include: {
    httpEndpoint: {
      include: {
        secretReference: true;
      };
    };
  };
}>;

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

    const webhook = await this.#upsertWebhook(endpoint, webhookMetadata);

    if (!webhook) {
      return;
    }

    return await this.#activateWebhook(endpoint, webhook);
  }

  async #upsertWebhook(endpoint: ExtendedEndpoint, webhookMetadata: WebhookMetadata) {
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
          environment: {
            connect: {
              id: endpoint.environmentId,
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
        include: {
          httpEndpoint: {
            include: {
              secretReference: true,
            },
          },
        },
      });

      return webhook;
    });
  }

  async #activateWebhook(endpoint: ExtendedEndpoint, webhook: ExtendedWebhook) {
    const { httpEndpoint } = webhook;

    const secretStore = getSecretStore(httpEndpoint.secretReference.provider);

    const secretData = await secretStore.getSecretOrThrow(
      z.object({ secret: z.string() }),
      httpEndpoint.secretReference.key
    );

    const ingestService = new IngestSendEvent();

    await ingestService.call(endpoint.environment, {
      id: ulid(),
      name: `${REGISTER_WEBHOOK}.${webhook.key}`,
      payload: {
        active: webhook.active,
        url: httpEndpointUrl({
          httpEndpointId: httpEndpoint.id,
          environment: endpoint.environment,
        }),
        secret: secretData.secret,
        params: webhook.params,
        config: {
          current: webhook.config ?? {},
          desired: webhook.desiredConfig ?? {},
        },
      },
    });
  }
}
