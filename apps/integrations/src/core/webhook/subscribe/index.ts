import {
  SubscribeGenericInput,
  SubscribeInput,
  SubscribeResult,
  SubscribeServiceInput,
  WebhookAuthentication,
} from "core/webhook/subscribe/types";
import { prisma, PrismaClient } from "db/db.server";
import { catalog } from "integrations/catalog";
import crypto from "node:crypto";
import { getCredentials } from "../credentials";
import { webhookUrl } from "./utilities";

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
    const key = `${service.service}-${event.name}-${event.createKey(
      input.data
    )}`;

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
        const newWebhookRow = await this.#createManualWebhook({
          requiresSecret: webhook.subscription.requiresSecret,
          consumerId: input.consumerId,
          key,
          service: input.service,
          webhookName: webhook.spec.id,
          authenticationData: input.authentication,
        });
        const destination = await this.#createDestination({
          webhookId: newWebhookRow.id,
          callbackUrl: input.callbackUrl,
          data: input.data,
          eventName: event.name,
        });

        return {
          success: true,
          result: {
            type: "service",
            webhookId: newWebhookRow.id,
            subscription: {
              type: "manual",
              url: webhookUrl(newWebhookRow.id),
              secret: newWebhookRow.secret ?? undefined,
            },
          },
        };
      }
      case "automatic": {
        const newWebhookRow = await this.#createAutomaticWebhook({
          requiresSecret: webhook.subscription.requiresSecret,
          consumerId: input.consumerId,
          key,
          service: input.service,
          webhookName: webhook.spec.id,
          authenticationData: input.authentication,
        });

        const credentials = await getCredentials({
          service,
          authentication: input.authentication,
        });

        if (!credentials) {
          return {
            success: false,
            error: {
              code: "credentials_not_found",
              message: `Credentials not found`,
            },
          };
        }

        const subscriptionResult = await webhook.subscription.subscribe({
          webhookId: newWebhookRow.id,
          callbackUrl: webhookUrl(newWebhookRow.id),
          events: [event.name],
          secret: newWebhookRow.secret ?? undefined,
          inputData: input.data,
          credentials,
        });

        if (!subscriptionResult.success) {
          return {
            success: false,
            error: {
              code: "subscription_failed",
              message: subscriptionResult.error,
            },
          };
        }

        //update status of the webhook to READY
        await this.#prismaClient.webhook.update({
          where: {
            id: newWebhookRow.id,
          },
          data: {
            status: "READY",
            secret: subscriptionResult.secret,
          },
        });

        //create destination
        const destination = await this.#createDestination({
          webhookId: newWebhookRow.id,
          callbackUrl: input.callbackUrl,
          data: input.data,
          eventName: event.name,
        });

        return {
          success: true,
          result: {
            type: "service",
            webhookId: newWebhookRow.id,
            subscription: {
              type: "automatic",
            },
          },
        };
      }
    }
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

  #createManualWebhook({
    requiresSecret,
    consumerId,
    key,
    service,
    webhookName,
    authenticationData,
  }: {
    requiresSecret: boolean;
    consumerId: string;
    key: string;
    service: string;
    webhookName: string;
    authenticationData: WebhookAuthentication;
  }) {
    const secret = requiresSecret
      ? crypto.randomBytes(32).toString("hex")
      : undefined;
    return this.#prismaClient.webhook.create({
      data: {
        type: "SERVICE",
        status: "READY",
        consumerId,
        key,
        secret,
        subscriptionType: "MANUAL",
        service,
        webhookName,
        authenticationData,
      },
    });
  }

  #createAutomaticWebhook({
    requiresSecret,
    consumerId,
    key,
    service,
    webhookName,
    authenticationData,
  }: {
    requiresSecret: boolean;
    consumerId: string;
    key: string;
    service: string;
    webhookName: string;
    authenticationData: WebhookAuthentication;
  }) {
    const secret = requiresSecret
      ? crypto.randomBytes(32).toString("hex")
      : undefined;
    return this.#prismaClient.webhook.create({
      data: {
        type: "SERVICE",
        status: "CREATED",
        consumerId,
        key,
        secret,
        subscriptionType: "AUTOMATIC",
        service,
        webhookName,
        authenticationData,
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
