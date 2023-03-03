import {
  SubscribeGenericInput,
  SubscribeInput,
  SubscribeResult,
  SubscribeServiceInput,
} from "core/webhook/subscribe/types";
import { prisma, PrismaClient } from "db/db.server";
import { catalog } from "integrations/catalog";
import crypto from "node:crypto";
import { webhookUrl } from "./webhooks.db";

export class SubscribeToWebhook {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(input: SubscribeInput): Promise<SubscribeResult> {
    switch (input.type) {
      case "service":
        return this.#subscribeToService(input);
      case "generic":
        return this.#subscribeToGeneric(input);
    }
  }

  async #subscribeToService(
    input: SubscribeServiceInput
  ): Promise<SubscribeResult> {
    const service = catalog.services[input.service];
    if (!service) {
      return {
        success: false,
        error: {
          code: "service_not_found",
          message: `Service ${input.service} not found`,
        },
      };
    }

    if (!service.webhooks) {
      return {
        success: false,
        error: {
          code: "service_does_not_support_webhooks",
          message: `Service ${input.service} does not support webhooks`,
        },
      };
    }

    const webhook = Object.values(service.webhooks).find((w) =>
      w.events.map((e) => e.name).includes(input.eventName)
    );
    const event = webhook?.events.find((e) => e.name === input.eventName);
    if (!webhook || !event) {
      return {
        success: false,
        error: {
          code: "event_not_found",
          message: `Event ${input.eventName} not found in service ${input.service}`,
        },
      };
    }

    //the key and consumerId are used to identify the webhook
    const key = `${service}-${event.name}-${event.createKey(input.data)}`;

    //is there an existing webhook?
    const existingWebhookRow = await this.#getWebhookRow({
      consumerId: input.consumerId,
      key,
    });

    if (existingWebhookRow) {
      try {
        const destination = await this.#createDestination({
          webhookId: existingWebhookRow.id,
          callbackUrl: input.callbackUrl,
          data: input.data,
          eventName: event.name,
        });

        const url = webhookUrl(existingWebhookRow.id);

        return {
          success: true,
          result: {
            type: "service",
            webhookId: existingWebhookRow.id,
            subscription:
              existingWebhookRow.subscriptionType === "MANUAL"
                ? {
                    type: "manual",
                    url,
                    secret: existingWebhookRow.secret ?? undefined,
                  }
                : {
                    type: "automatic",
                  },
          },
        };
      } catch (e) {
        return {
          success: false,
          error: {
            code: "destination_already_exists",
            message: `Destination already exists`,
          },
        };
      }
    }

    switch (webhook.subscription.type) {
      case "manual": {
        const secret = webhook.subscription.requiresSecret
          ? crypto.randomBytes(32).toString("hex")
          : undefined;
        const newWebhookRow = await this.#prismaClient.webhook.create({
          data: {
            type: "SERVICE",
            status: "READY",
            consumerId: input.consumerId,
            key,
            secret,
            subscriptionType: "MANUAL",
            service: input.service,
            webhookName: webhook.spec.id,
            authenticationData: input.authentication,
          },
        });

        const destination = await this.#prismaClient.destination.create({
          data: {
            webhook: {
              connect: {
                id: newWebhookRow.id,
              },
            },
            destinationUrl: input.callbackUrl,
            destinationEvent: event.name,
            destinationData: input.data,
          },
        });
        break;
      }
      case "automatic": {
        break;
      }
    }

    //todo create destination in db

    //todo determine if it's automatic or manual
  }

  async #subscribeToGeneric(
    input: SubscribeGenericInput
  ): Promise<SubscribeResult> {
    throw new Error("Not implemented");
  }

  #getWebhookRow({ consumerId, key }: { consumerId: string; key: string }) {
    return this.#prismaClient.webhook.findUnique({
      where: {
        consumerId_key: {
          consumerId,
          key,
        },
      },
    });
  }

  #createDestination({
    webhookId,
    callbackUrl,
    eventName,
    data,
  }: {
    webhookId: string;
    callbackUrl: string;
    eventName: string;
    data: any;
  }) {
    const destinationSecret = crypto.randomBytes(32).toString("hex");
    return this.#prismaClient.destination.create({
      data: {
        webhook: {
          connect: {
            id: webhookId,
          },
        },
        destinationUrl: callbackUrl,
        destinationSecret,
        destinationEvent: eventName,
        destinationData: data,
      },
    });
  }
}
