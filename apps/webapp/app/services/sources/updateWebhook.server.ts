import { type TriggerSource , type UpdateWebhookBody } from '@trigger.dev/core/schemas';
import type { RuntimeEnvironment } from "@trigger.dev/database";
import { prisma ,type  PrismaClient  } from "~/db.server";

export class UpdateWebhookService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    payload,
    key,
  }: {
    environment: RuntimeEnvironment;
    payload: UpdateWebhookBody;
    key: string;
  }): Promise<TriggerSource> {
    const webhook = await this.#prismaClient.webhook.findUniqueOrThrow({
      where: {
        key_projectId: {
          key,
          projectId: environment.projectId,
        },
      },
    });

    await this.#prismaClient.webhook.update({
      where: {
        key_projectId: {
          key,
          projectId: environment.projectId,
        },
      },
      data: {
        active: payload.active,
        webhookEnvironments: {
          update: {
            where: {
              environmentId_webhookId: {
                environmentId: environment.id,
                webhookId: webhook.id,
              },
            },
            data: {
              active: payload.active,
              config: payload.active ? payload.config : undefined,
            },
          },
        },
      },
    });

    return {
      id: webhook.id,
      key: webhook.key,
    };
  }
}
