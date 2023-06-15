import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type {
  TriggerSource,
  SecretReference,
  TriggerSourceEvent,
} from "@trigger.dev/database";
import type { AuthenticatedEnvironment } from "../apiAuth.server";
import { env } from "~/env.server";
import {
  REGISTER_SOURCE_EVENT,
  RegisterTriggerSource,
} from "@trigger.dev/internal";
import {
  SecretStoreProvider,
  getSecretStore,
} from "../secrets/secretStore.server";
import { SecretStore } from "../secrets/secretStore.server";
import { z } from "zod";
import { IngestSendEvent } from "../events/ingestSendEvent.server";

export class ActivateSourceService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, jobId: string, orphanedEvents?: Array<string>) {
    const triggerSource =
      await this.#prismaClient.triggerSource.findUniqueOrThrow({
        where: {
          id,
        },
        include: {
          endpoint: true,
          environment: {
            include: {
              organization: true,
              project: true,
            },
          },
          events: true,
          secretReference: true,
        },
      });

    const eventId = `${id}:${jobId}`;

    // TODO: support more channels
    switch (triggerSource.channel) {
      case "HTTP": {
        await this.#activateHttpSource(
          triggerSource.environment,
          triggerSource,
          triggerSource.events,
          triggerSource.secretReference,
          eventId,
          orphanedEvents
        );
      }
    }
  }

  async #activateHttpSource(
    environment: AuthenticatedEnvironment,
    triggerSource: TriggerSource,
    events: Array<TriggerSourceEvent>,
    secretReference: SecretReference,
    eventId: string,
    orphanedEvents?: Array<string>
  ) {
    const secretStore = getSecretStore(secretReference.provider);
    const httpSecret = await secretStore.getSecret(
      z.object({
        secret: z.string(),
      }),
      secretReference.key
    );

    if (!httpSecret) {
      throw new Error("HTTP Secret not found");
    }

    const eventNames = triggerSource.active
      ? events.filter((e) => e.registered).map((e) => e.name)
      : events.map((e) => e.name);

    const missingEvents = triggerSource.active
      ? events.filter((e) => !e.registered).map((e) => e.name)
      : [];

    const service = new IngestSendEvent();

    const source: RegisterTriggerSource = {
      key: triggerSource.key,
      active: triggerSource.active,
      secret: httpSecret.secret,
      data: triggerSource.channelData as any,
      channel: {
        type: "HTTP",
        url: `${env.APP_ORIGIN}/api/v1/sources/http/${triggerSource.id}`,
      },
    };

    await service.call(environment, {
      id: eventId,
      name: REGISTER_SOURCE_EVENT,
      source: "trigger.dev",
      payload: {
        id: triggerSource.id,
        source,
        events: eventNames,
        missingEvents,
        orphanedEvents: orphanedEvents ?? [],
      },
    });
  }
}
