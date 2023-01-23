import type {
  HandledExternalEventResponse,
  NormalizedRequest,
} from "internal-integrations";
import { airtable, github } from "internal-integrations";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { ExternalSourceWithConnection } from "~/models/externalSource.server";
import { getAccessInfo } from "../accessInfo.server";
import { IngestEvent } from "../events/ingest.server";

export class HandleExternalSource {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async #createNormalizedRequest(request: Request): Promise<NormalizedRequest> {
    const requestUrl = new URL(request.url);
    const rawSearchParams = requestUrl.searchParams;
    const rawBody = await request.json();
    const rawHeaders = Object.fromEntries(request.headers.entries());

    return {
      body: rawBody,
      headers: rawHeaders,
      searchParams: rawSearchParams,
    };
  }

  public async call(
    externalSource: NonNullable<ExternalSourceWithConnection>,
    serviceIdentifier: string,
    request: Request
  ) {
    const normalizedRequest = await this.#createNormalizedRequest(request);

    const possibleEvent = await this.#handleExternalSource(
      externalSource,
      serviceIdentifier,
      normalizedRequest
    );

    switch (possibleEvent.status) {
      case "ok": {
        //loop over the events and ingest them
        for (let index = 0; index < possibleEvent.data.length; index++) {
          const { id, payload, event, timestamp, context } =
            possibleEvent.data[index];

          const ingestService = new IngestEvent();

          await ingestService.call(
            {
              id,
              payload,
              name: event,
              type: externalSource.type,
              service: serviceIdentifier,
              timestamp,
              context,
            },
            externalSource.organization
          );
        }

        return true;
      }
      case "ignored": {
        console.log(`Ignored external event: ${possibleEvent.reason}`);

        return true;
      }
      case "error": {
        throw new Error(possibleEvent.error);
      }
    }
  }

  async #handleExternalSource(
    externalSource: NonNullable<ExternalSourceWithConnection>,
    serviceIdentifier: string,
    normalizedRequest: NormalizedRequest
  ): Promise<HandledExternalEventResponse> {
    switch (externalSource.type) {
      case "WEBHOOK": {
        return this.#handleWebhook(
          externalSource,
          serviceIdentifier,
          normalizedRequest
        );
      }
      default: {
        return {
          status: "error",
          error: `Could not handle external source with unsupported type: ${externalSource.type}`,
        };
      }
    }
  }

  async #handleWebhook(
    externalSource: NonNullable<ExternalSourceWithConnection>,
    serviceIdentifier: string,
    request: NormalizedRequest
  ): Promise<HandledExternalEventResponse> {
    if (externalSource.connection === null) {
      return {
        status: "error",
        error: `Could not handle webhook with no API connection. ExternalSource id: ${externalSource.id}`,
      };
    }

    const accessInfo = await getAccessInfo(externalSource.connection);

    if (accessInfo === undefined) {
      return {
        status: "error",
        error: `Could not handle webhook with no AccessInfo. ExternalSource id: ${externalSource.id}. Connection id: ${externalSource.connection.id}`,
      };
    }

    switch (serviceIdentifier) {
      case "github": {
        return await github.webhooks.handleWebhookRequest({
          accessInfo,
          request,
          secret: externalSource.secret ?? undefined,
        });
      }
      case "airtable": {
        const latestTriggerEvent = this.#prismaClient.triggerEvent.findFirst({
          where: {
            key: request.body.base.id,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

        return await airtable.webhooks.handleWebhookRequest({
          accessInfo,
          request,
          secret: externalSource.secret ?? undefined,
          options: {
            latestTriggerEvent,
          },
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
