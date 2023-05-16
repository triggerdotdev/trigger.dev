import type { RuntimeEnvironment } from ".prisma/client";
import type {
  TriggerSource,
  UpdateTriggerSourceBody,
} from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { SecretStoreProvider } from "../secrets/secretStore.server";
import { SecretStore } from "../secrets/secretStore.server";

export class UpdateSourceService {
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
    payload: UpdateTriggerSourceBody;
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

    const triggerSource =
      await this.#prismaClient.triggerSource.findUniqueOrThrow({
        where: {
          key_endpointId: {
            endpointId: endpoint.id,
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
        channelData: payload.data
          ? JSON.parse(JSON.stringify(payload.data))
          : undefined,
      },
    });

    for (const event of payload.registeredEvents) {
      await this.#prismaClient.triggerSourceEvent.update({
        where: {
          name_sourceId: {
            name: event,
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
      const secretStore = new SecretStore(
        triggerSource.secretReference.provider as SecretStoreProvider
      );

      await secretStore.setSecret<{ secret: string }>(
        triggerSource.secretReference.key,
        {
          secret: payload.secret,
        }
      );
    }

    return {
      id: triggerSource.id,
      key: triggerSource.key,
    };
  }
}
