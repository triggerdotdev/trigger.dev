import { InitializeTriggerBody } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { ClientApi } from "../clientApi.server";
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
          endpointId_slug: {
            endpointId: endpoint.id,
            slug: id,
          },
        },
      });

    const clientApi = new ClientApi(environment.apiKey, endpoint.url);

    const registerMetadata = await clientApi.initializeTrigger(
      dynamicTrigger.slug,
      payload.params
    );

    if (!registerMetadata) {
      throw new Error("Could not initialize trigger");
    }

    const triggerSource = await this.#registerTriggerSource.call({
      environment,
      payload: registerMetadata,
      id: dynamicTrigger.slug,
      endpointSlug,
    });

    await this.#sendEvent.call(environment, {
      id: triggerSource.source.key,
      name: "trigger.internal.registerSource",
      source: "trigger.dev",
      payload: {
        ...triggerSource,
        dynamicTriggerId: dynamicTrigger.slug,
      },
    });
  }
}
