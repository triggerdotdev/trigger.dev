import {
  SubscribeGenericInput,
  SubscribeInput,
  SubscribeResult,
  SubscribeServiceInput,
} from "core/webhook/subscribe/types";
import { prisma, PrismaClient } from "db/db.server";
import { catalog } from "integrations/catalog";

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
    const key = event.createKey(input.data);

    //is there an existing webhook?

    //todo create webhook in db

    //todo determine if it's automatic or manual
  }

  async #subscribeToGeneric(
    input: SubscribeGenericInput
  ): Promise<SubscribeResult> {
    throw new Error("Not implemented");
  }
}
