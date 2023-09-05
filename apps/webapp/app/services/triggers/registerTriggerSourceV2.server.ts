import {
  RegisterSourceEventOptions,
  RegisterSourceEventV2,
  RegisterTriggerBodyV2,
  RegisteredOptionsDiff,
} from "@trigger.dev/core";
import { z } from "zod";
import { $transaction, PrismaClient, prisma } from "~/db.server";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { getSecretStore } from "../secrets/secretStore.server";
import { RegisterSourceServiceV2 } from "../sources/registerSourceV2.server";

export class RegisterTriggerSourceServiceV2 {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    payload,
    endpointSlug,
    id,
    key,
    accountId,
    registrationMetadata,
  }: {
    environment: AuthenticatedEnvironment;
    payload: RegisterTriggerBodyV2;
    id: string;
    endpointSlug: string;
    key: string;
    accountId?: string;
    registrationMetadata?: any;
  }): Promise<RegisterSourceEventV2 | undefined> {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        environmentId_slug: {
          environmentId: environment.id,
          slug: endpointSlug,
        },
      },
    });

    const dynamicTrigger = await this.#prismaClient.dynamicTrigger.findUniqueOrThrow({
      where: {
        endpointId_slug_type: {
          endpointId: endpoint.id,
          slug: id,
          type: "EVENT",
        },
      },
    });

    return await $transaction(
      this.#prismaClient,
      async (tx) => {
        const service = new RegisterSourceServiceV2(tx);

        const triggerSource = await service.call(
          endpoint.id,
          payload.source,
          dynamicTrigger.id,
          accountId,
          { id: key, metadata: registrationMetadata }
        );

        if (!triggerSource) {
          return;
        }

        const eventDispatcher = await tx.eventDispatcher.upsert({
          where: {
            dispatchableId_environmentId: {
              dispatchableId: triggerSource.id,
              environmentId: environment.id,
            },
          },
          create: {
            dispatchableId: triggerSource.id,
            environmentId: environment.id,
            event: Array.isArray(payload.rule.event) ? payload.rule.event : [payload.rule.event],
            source: payload.rule.source,
            payloadFilter: payload.rule.payload,
            contextFilter: payload.rule.context,
            dispatchable: {
              type: "DYNAMIC_TRIGGER",
              id: dynamicTrigger.id,
            },
          },
          update: {
            event: Array.isArray(payload.rule.event) ? payload.rule.event : [payload.rule.event],
            source: payload.rule.source,
            payloadFilter: payload.rule.payload,
            contextFilter: payload.rule.context,
            dispatchable: {
              type: "DYNAMIC_TRIGGER",
              id: dynamicTrigger.id,
            },
          },
        });

        const registration = await tx.dynamicTriggerRegistration.upsert({
          where: {
            key_dynamicTriggerId: {
              key,
              dynamicTriggerId: dynamicTrigger.id,
            },
          },
          create: {
            key,
            dynamicTriggerId: dynamicTrigger.id,
            sourceId: triggerSource.id,
            eventDispatcherId: eventDispatcher.id,
            metadata: registrationMetadata,
          },
          update: {
            metadata: registrationMetadata,
          },
        });

        const secretStore = getSecretStore(triggerSource.secretReference.provider, {
          prismaClient: tx,
        });

        const { secret } = await secretStore.getSecretOrThrow(
          z.object({
            secret: z.string(),
          }),
          triggerSource.secretReference.key
        );

        //turn into required format
        const optionsArray = Object.entries(payload.source.options).flatMap(([name, values]) => {
          return { name, values };
        });
        const options = optionsArray.reduce((acc, { name, values }) => {
          acc[name] = {
            desired: [...new Set(values)],
            missing: [],
            orphaned: [],
          };
          return acc;
        }, {} as Record<string, { desired: string[]; missing: string[]; orphaned: string[] }>) as RegisterSourceEventOptions;

        const data: RegisterSourceEventV2 = {
          id: registration.id,
          source: {
            key: triggerSource.key,
            active: triggerSource.active,
            params: triggerSource.params,
            secret,
            data: triggerSource.channelData as any,
            channel: {
              type: "HTTP",
              url: `${env.APP_ORIGIN}/api/v1/sources/http/${triggerSource.id}`,
            },
            clientId: triggerSource.integration.slug,
          },
          options,
        };

        return data;
      },
      { timeout: 15000 }
    );
  }
}
