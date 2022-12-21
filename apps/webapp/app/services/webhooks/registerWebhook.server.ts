import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { RegisteredWebhookWithRelationships } from "~/models/registeredWebhook.server";
import { github } from "internal-integrations";
import { pizzly } from "../pizzly.server";
import { originOrProxyUrl } from "../webhookProxy.server";

export class RegisterWebhook {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(webhook: RegisteredWebhookWithRelationships) {
    if (webhook.status === "CONNECTED") {
      return true;
    }

    if (!webhook.connectionSlot || !webhook.connectionSlot.connection) {
      return true; // Somehow the connection slot was deleted, so by returning true we're saying we're done with this webhook
    }

    const accessToken = await pizzly.accessToken(
      webhook.connectionSlot.connection.apiIdentifier,
      webhook.connectionSlot.connection.id
    );

    const webhookUrl = `${originOrProxyUrl}/api/v1/internal/webhooks/${webhook.connectionSlot.connection.apiIdentifier}/${webhook.id}`;

    const serviceWebhook = await this.#registerWebhookWithConnection(
      webhook.connectionSlot.connection.apiIdentifier,
      accessToken,
      webhookUrl,
      webhook.secret,
      webhook.connectionSlot.auth
    );

    await this.#prismaClient.registeredWebhook.update({
      where: {
        id: webhook.id,
      },
      data: {
        status: "CONNECTED",
        webhookConfig: serviceWebhook,
      },
    });

    return true;
  }

  async #registerWebhookWithConnection(
    serviceIdentifier: string,
    accessToken: string,
    callbackUrl: string,
    secret: string,
    data: unknown
  ) {
    switch (serviceIdentifier) {
      case "github": {
        return github.webhooks.registerWebhook(
          {
            callbackUrl,
            secret: secret,
            accessToken,
          },
          data
        );
      }
      default: {
        throw new Error(
          `Could not register webhook with unsupported service identifier: ${serviceIdentifier}`
        );
      }
    }
  }
}
