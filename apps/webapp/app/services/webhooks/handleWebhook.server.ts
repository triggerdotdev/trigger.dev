import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { RegisteredWebhookWithRelationships } from "~/models/registeredWebhook.server";
import { github } from "internal-integrations";

export class HandleWebhook {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    webhook: RegisteredWebhookWithRelationships,
    serviceIdentifier: string,
    request: Request
  ) {
    const requestUrl = new URL(request.url);
    const rawSearchParams = requestUrl.searchParams;
    const rawBody = await request.json();
    const rawHeaders = Object.fromEntries(request.headers.entries());

    const handledWebhook = await this.#handleWebhook(
      webhook,
      serviceIdentifier,
      rawBody,
      rawHeaders,
      rawSearchParams
    );

    switch (handledWebhook.status) {
      case "ok": {
        const { id, payload } = handledWebhook.data;

        console.log(
          `Received webhook event: ${id} with payload:\n${JSON.stringify(
            payload,
            null,
            2
          )}}`
        );

        return true;
      }
      case "ignored": {
        console.log(`Ignored webhook event: ${handledWebhook.reason}`);

        return true;
      }
      case "error": {
        throw new Error(handledWebhook.error);
      }
    }
  }

  async #handleWebhook(
    webhook: RegisteredWebhookWithRelationships,
    serviceIdentifier: string,
    rawBody: any,
    rawHeaders: Record<string, string>,
    rawSearchParams: URLSearchParams
  ) {
    switch (serviceIdentifier) {
      case "github": {
        return github.webhooks.handleWebhookRequest({
          request: {
            body: rawBody,
            headers: rawHeaders,
            searchParams: rawSearchParams,
          },
          secret: webhook.secret,
          params: webhook.connectionSlot.auth,
        });
      }
      default: {
        throw new Error(
          `Could not handle webhook with unsupported service identifier: ${serviceIdentifier}`
        );
      }
    }
  }
}
