import * as github from "@trigger.dev/github/internal";
import type { NormalizedRequest } from "@trigger.dev/integration-sdk";
import * as whatsapp from "@trigger.dev/whatsapp/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { ExternalSourceWithConnection } from "~/models/externalSource.server";
import { createNormalizedRequest } from "./utils";

type ErrorEventResponse = {
  status: "error";
  error: string;
};
type IgnoredEventResponse = {
  status: "ignored";
  reason: string;
};

type TriggeredEventResponse = {
  status: "ok";
  data: any;
};

export type VerifyExternalEventResponse =
  | TriggeredEventResponse
  | IgnoredEventResponse
  | ErrorEventResponse;

export class VerifyExternalSource {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    externalSource: NonNullable<ExternalSourceWithConnection>,
    serviceIdentifier: string,
    request: Request
  ): Promise<VerifyExternalEventResponse> {
    const normalizedRequest = await createNormalizedRequest(request);
    return this.#verifyExternalSource(
      externalSource,
      serviceIdentifier,
      normalizedRequest
    );
  }

  async #verifyExternalSource(
    externalSource: NonNullable<ExternalSourceWithConnection>,
    serviceIdentifier: string,
    normalizedRequest: NormalizedRequest
  ): Promise<VerifyExternalEventResponse> {
    switch (externalSource.type) {
      case "WEBHOOK": {
        return this.#verifyWebhook(
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

  async #verifyWebhook(
    externalSource: NonNullable<ExternalSourceWithConnection>,
    serviceIdentifier: string,
    request: NormalizedRequest
  ): Promise<VerifyExternalEventResponse> {
    switch (serviceIdentifier) {
      case "github": {
        return github.internalIntegration.webhooks!.verifyWebhookRequest({
          request,
          secret: externalSource.secret ?? undefined,
        });
      }
      case "whatsapp": {
        return whatsapp.internalIntegration.webhooks!.verifyWebhookRequest({
          request,
          secret: externalSource.secret ?? undefined,
        });
      }
    }

    if (externalSource.manualRegistration) {
      return this.#handleManualWebhook(
        externalSource,
        serviceIdentifier,
        request
      );
    }

    return {
      status: "ignored" as const,
      reason: `Could not handle external source with unsupported service: ${serviceIdentifier}`,
    };
  }

  async #handleManualWebhook(
    externalSource: NonNullable<ExternalSourceWithConnection>,
    serviceIdentifier: string,
    request: NormalizedRequest
  ): Promise<VerifyExternalEventResponse> {
    return {
      status: "ok" as const,
      data: undefined,
    };
  }
}
