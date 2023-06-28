import {
  InitializeTriggerBody,
  REGISTER_SOURCE_EVENT,
} from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { EndpointApi } from "../endpointApi.server";
import { RegisterTriggerSourceService } from "./registerTriggerSource.server";
import { IngestSendEvent } from "../events/ingestSendEvent.server";

export class InitializeTriggerService {
  #prismaClient: PrismaClient;
  #registerTriggerSource = new RegisterTriggerSourceService();
  #sendEvent = new IngestSendEvent();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    payload,
    endpointSlug,
    id,
  }: {
    environment: AuthenticatedEnvironment;
    payload: InitializeTriggerBody;
    id: string;
    endpointSlug: string;
  }) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        environmentId_slug: {
          environmentId: environment.id,
          slug: endpointSlug,
        },
      },
    });

    const dynamicTrigger =
      await this.#prismaClient.dynamicTrigger.findUniqueOrThrow({
        where: {
          endpointId_slug_type: {
            endpointId: endpoint.id,
            slug: id,
            type: "EVENT",
          },
        },
      });

    const clientApi = new EndpointApi(
      environment.apiKey,
      endpoint.url,
      endpoint.slug
    );

    const registerMetadata = await clientApi.initializeTrigger(
      dynamicTrigger.slug,
      payload.params
    );

    if (!registerMetadata) {
      throw new Error("Could not initialize trigger");
    }

    const registration = await this.#registerTriggerSource.call({
      environment,
      payload: registerMetadata,
      id: dynamicTrigger.slug,
      endpointSlug,
      key: payload.id,
      accountId: payload.accountId,
      registrationMetadata: payload.metadata,
    });

    await this.#sendEvent.call(
      environment,
      {
        id: registration.id,
        name: REGISTER_SOURCE_EVENT,
        source: "trigger.dev",
        payload: {
          ...registration,
          dynamicTriggerId: dynamicTrigger.slug,
        },
      },
      { accountId: payload.accountId }
    );

    return registration;
  }
}
