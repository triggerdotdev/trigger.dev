import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import {
  RegisterSourceEvent,
  RegisterTriggerBody,
} from "@trigger.dev/internal";
import { RegisterSourceService } from "../sources/registerSource.server";
import {
  SecretStore,
  SecretStoreProvider,
} from "../secrets/secretStore.server";
import { z } from "zod";
import { env } from "~/env.server";

export class RegisterTriggerService {
  #prismaClient: PrismaClient;
  #registerSource = new RegisterSourceService();

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
    payload: RegisterTriggerBody;
    id: string;
    endpointSlug: string;
  }): Promise<RegisterSourceEvent> {
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

    const triggerSource = await this.#registerSource.call(
      endpoint.id,
      payload.source,
      dynamicTrigger.id
    );

    await this.#prismaClient.eventDispatcher.upsert({
      where: {
        dispatchableId_environmentId: {
          dispatchableId: triggerSource.id,
          environmentId: environment.id,
        },
      },
      create: {
        dispatchableId: triggerSource.id,
        environmentId: environment.id,
        event: payload.rule.event,
        source: payload.rule.source,
        payloadFilter: payload.rule.payload,
        contextFilter: payload.rule.context,
        dispatchable: {
          type: "DYNAMIC_TRIGGER",
          id: dynamicTrigger.id,
        },
      },
      update: {
        event: payload.rule.event,
        source: payload.rule.source,
        payloadFilter: payload.rule.payload,
        contextFilter: payload.rule.context,
        dispatchable: {
          type: "DYNAMIC_TRIGGER",
          id: dynamicTrigger.id,
        },
      },
    });

    const secretStore = new SecretStore(
      triggerSource.secretReference.provider as SecretStoreProvider
    );

    const { secret } = await secretStore.getSecretOrThrow(
      z.object({
        secret: z.string(),
      }),
      triggerSource.secretReference.key
    );

    return {
      source: {
        key: triggerSource.key,
        active: triggerSource.active,
        secret,
        data: triggerSource.channelData as any,
        channel: {
          type: "HTTP",
          url: `${env.APP_ORIGIN}/api/v3/sources/http/${triggerSource.id}`,
        },
        clientId: triggerSource.apiClient?.slug,
      },
      events: triggerSource.events.map((e) => e.name),
      missingEvents: [],
      orphanedEvents: [],
    };
  }
}
