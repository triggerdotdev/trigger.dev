import { type InitializeTriggerBody , REGISTER_SOURCE_EVENT_V1 } from '@trigger.dev/core/schemas';
import { prisma ,type  PrismaClient  } from "~/db.server";
import { type AuthenticatedEnvironment } from "../apiAuth.server";
import { EndpointApi } from "../endpointApi.server";
import { RegisterTriggerSourceServiceV1 } from "./registerTriggerSourceV1.server";
import { IngestSendEvent } from "../events/ingestSendEvent.server";

export class InitializeTriggerService {
  #prismaClient: PrismaClient;
  #registerTriggerSource = new RegisterTriggerSourceServiceV1();
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

    if (!endpoint.url) {
      throw new Error("This environment's endpoint doesn't have a URL set");
    }

    const dynamicTrigger = await this.#prismaClient.dynamicTrigger.findUniqueOrThrow({
      where: {
        endpointId_slug_type: {
          endpointId: endpoint.id,
          slug: id,
          type: "EVENT",
        },
      },
    });

    const clientApi = new EndpointApi(environment.apiKey, endpoint.url);

    const registerMetadata = await clientApi.initializeTrigger(dynamicTrigger.slug, payload.params);

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

    if (!registration) {
      return;
    }

    await this.#sendEvent.call(
      environment,
      {
        id: registration.id,
        name: REGISTER_SOURCE_EVENT_V1,
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
