import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { airtable, github } from "internal-integrations";
import type { ExternalSourceWithConnection } from "~/models/externalSource.server";
import type { NormalizedRequest } from "internal-integrations";
import { IngestEvent } from "../events/ingest.server";

type IgnoredEventResponse = {
  status: "ignored";
  reason: string;
};

type ErrorEventResponse = {
  status: "error";
  error: string;
};

type TriggeredEventResponse = {
  status: "ok";
  data: {
    id: string;
    payload: any;
    event: string;
    timestamp?: string;
    context?: any;
  };
};

export type HandledExternalEventResponse =
  | TriggeredEventResponse
  | IgnoredEventResponse
  | ErrorEventResponse;

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
        const { id, payload, event, timestamp, context } = possibleEvent.data;

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
    switch (serviceIdentifier) {
      case "github": {
        return github.webhooks.handleWebhookRequest({
          request,
          secret: externalSource.secret ?? undefined,
        });
      }
      case "airtable": {
        return airtable.webhooks.handleWebhookRequest({
          request,
          secret: externalSource.secret ?? undefined,
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
