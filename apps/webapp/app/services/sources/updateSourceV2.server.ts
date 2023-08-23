import type { TriggerSource, UpdateTriggerSourceBodyV2 } from "@trigger.dev/core";
import type { RuntimeEnvironment } from "@trigger.dev/database";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getSecretStore } from "../secrets/secretStore.server";

export class UpdateSourceServiceV2 {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    payload,
    id,
    endpointSlug,
  }: {
    environment: RuntimeEnvironment;
    payload: UpdateTriggerSourceBodyV2;
    id: string;
    endpointSlug: string;
  }): Promise<TriggerSource> {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        environmentId_slug: {
          environmentId: environment.id,
          slug: endpointSlug,
        },
      },
    });

    const triggerSource = await this.#prismaClient.triggerSource.findUniqueOrThrow({
      where: {
        key_environmentId: {
          environmentId: environment.id,
          key: id,
        },
      },
      include: {
        secretReference: true,
      },
    });

    await this.#prismaClient.triggerSource.update({
      where: {
        id: triggerSource.id,
      },
      data: {
        active: true,
        channelData: payload.data as any,
        endpointId: endpoint.id,
      },
    });

    const flatOptions = Object.entries(payload.options).flatMap(([name, value]) =>
      value.map((v) => ({
        name,
        value: v,
      }))
    );

    for (const { name, value } of flatOptions) {
      await this.#prismaClient.triggerSourceOption.update({
        where: {
          name_value_sourceId: {
            name,
            value,
            sourceId: triggerSource.id,
          },
        },
        data: {
          registered: true,
        },
      });
    }

    if (payload.secret) {
      // We need to update the secret reference in the store
      const secretStore = getSecretStore(triggerSource.secretReference.provider);

      await secretStore.setSecret<{ secret: string }>(triggerSource.secretReference.key, {
        secret: payload.secret,
      });
    }

    return {
      id: triggerSource.id,
      key: triggerSource.key,
    };
  }
}
