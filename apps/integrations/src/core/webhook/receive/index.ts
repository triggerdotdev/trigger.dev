import {
  Destination as DestinationRow,
  Webhook as WebhookRow,
} from ".prisma/client";
import { createDeliveriesAndTasks } from "core/jobs/tasks/webhookJob";
import { prisma, PrismaClient } from "db/db.server";
import { catalog } from "integrations/catalog";
import { getCredentials } from "../credentials";
import { AuthenticationSchema } from "../subscribe/types";
import { WebhookIncomingRequest, WebhookResult } from "../types";

type WebhookWithDestinations = WebhookRow & {
  destinations: DestinationRow[];
};

export class ReceiveWebhook {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    webhookId,
    request,
  }: {
    webhookId: string;
    request: WebhookIncomingRequest;
  }): Promise<WebhookResult> {
    //get webhook and destinations from the db
    const webhookRow = await this.#getWebhookAndDestinationRow(webhookId);
    if (!webhookRow) {
      return {
        success: false,
        error: `Webhook ${webhookId} not found`,
        response: {
          status: 404,
          headers: {},
          body: `Webhook ${webhookId} not found`,
        },
      };
    }
    if (webhookRow.destinations.length === 0) {
      return {
        success: false,
        error: `Webhook ${webhookId} has no destinations`,
        response: {
          status: 404,
          headers: {},
          body: `Webhook ${webhookId} has no destinations`,
        },
      };
    }

    //if service webhook then collect together objects
    let result: WebhookResult;
    switch (webhookRow.type) {
      case "SERVICE": {
        result = await this.#handleServiceWebhook(webhookRow, request);
        break;
      }
      case "GENERIC": {
        result = await this.#handleGenericWebhook(webhookRow, request);
        break;
      }
      default: {
        throw new Error(`Unknown webhook type ${webhookRow.type}`);
      }
    }

    //create deliveries and jobs in Graphile Worker
    if (result.success) {
      await createDeliveriesAndTasks({
        eventResults: result.eventResults,
        destinations: webhookRow.destinations,
      });
    }

    //return response
    return result;
  }

  async #handleServiceWebhook(
    webhookRow: WebhookWithDestinations,
    request: WebhookIncomingRequest
  ): Promise<WebhookResult> {
    const service = webhookRow.service
      ? catalog.services[webhookRow.service]
      : undefined;
    if (!service) {
      return {
        success: false,
        error: `Service ${webhookRow.service} not found`,
        response: {
          status: 404,
          headers: {},
          body: `Service ${webhookRow.service} not found`,
        },
      };
    }

    if (!service.webhooks) {
      return {
        success: false,
        error: `Service ${webhookRow.service} doesn't have webhooks`,
        response: {
          status: 404,
          headers: {},
          body: `Service ${webhookRow.service} doesn't have webhooks`,
        },
      };
    }
    if (!webhookRow.webhookName) {
      return {
        success: false,
        error: `Webhook ${webhookRow.id} doesn't have a webhook name`,
        response: {
          status: 404,
          headers: {},
          body: `Webhook ${webhookRow.id} doesn't have a webhook name`,
        },
      };
    }

    const webhookName = webhookRow.webhookName;
    const webhook = Object.values(service.webhooks).find(
      (w) => w.spec.id === webhookName
    );
    if (!webhook) {
      return {
        success: false,
        error: `Webhook ${webhookRow.webhookName} doesn't exist in service ${webhookRow.service}`,
        response: {
          status: 404,
          headers: {},
          body: `Webhook ${webhookRow.webhookName} doesn't exist in service ${webhookRow.service}`,
        },
      };
    }

    const authenticationData = AuthenticationSchema.safeParse(
      webhookRow.authenticationData
    );
    if (!authenticationData.success) {
      return {
        success: false,
        error: `Webhook ${webhookRow.id} has invalid authentication data`,
        response: {
          status: 404,
          headers: {},
          body: `Webhook ${webhookRow.id} has invalid authentication data`,
        },
      };
    }

    const credentials = await getCredentials({
      service,
      authentication: authenticationData.data,
    });

    const result = await webhook.receive({
      credentials,
      secret: webhookRow.secret ?? undefined,
      subscriptionData: webhookRow.externalData
        ? (webhookRow.externalData as Record<string, any>)
        : {},
      request,
    });

    return result;
  }

  async #handleGenericWebhook(
    webhookRow: WebhookWithDestinations,
    request: WebhookIncomingRequest
  ): Promise<WebhookResult> {
    throw new Error("Method not implemented.");
  }

  #getWebhookAndDestinationRow(id: string) {
    return this.#prismaClient.webhook.findUnique({
      where: {
        id,
      },
      include: {
        destinations: true,
      },
    });
  }
}
