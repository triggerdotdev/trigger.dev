import { REGISTER_WEBHOOK, WebhookMetadata } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";
import { IngestSendEvent } from "../events/ingestSendEvent.server";
import { Prisma, WebhookEnvironment } from "@trigger.dev/database";
import { ulid } from "../ulid.server";
import { getSecretStore } from "../secrets/secretStore.server";
import { z } from "zod";
import { httpEndpointUrl } from "../httpendpoint/HandleHttpEndpointService.server";
import { isEqual } from "ohash";

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

    const upsertResult = await this.#upsertWebhook(endpoint, webhookMetadata);

    if (!upsertResult) {
      return;
    }

    const { webhook, webhookEnvironment } = upsertResult;
    const { config, desiredConfig } = webhookEnvironment;

    if (webhook.active && isEqual(config, desiredConfig)) {
      return;
    }

    return await this.#activateWebhook(endpoint, webhook, webhookEnvironment);
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
        },
        include: {
          httpEndpoint: {
            include: {
              secretReference: true,
            },
          },
        },
      });

      const webhookEnvironment = await tx.webhookEnvironment.upsert({
        where: {
          environmentId_webhookId: {
            environmentId: endpoint.environmentId,
            webhookId: webhook.id,
          },
        },
        create: {
          desiredConfig: webhookMetadata.config,
          webhook: {
            connect: {
              id: webhook.id,
            },
          },
          environment: {
            connect: {
              id: endpoint.environmentId,
            },
          },
          endpoint: {
            connect: {
              id: endpoint.id,
            },
          },
        },
        update: {
          desiredConfig: webhookMetadata.config,
        },
      });

      return { webhook, webhookEnvironment };
    });
  }

  async #activateWebhook(
    endpoint: ExtendedEndpoint,
    webhook: ExtendedWebhook,
    webhookEnvironment: WebhookEnvironment
  ) {
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
          current: webhookEnvironment.config ?? {},
          desired: webhookEnvironment.desiredConfig ?? {},
        },
      },
    });
  }
}
