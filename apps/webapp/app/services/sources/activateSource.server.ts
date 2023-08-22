import {
  REGISTER_SOURCE_EVENT,
  REGISTER_SOURCE_EVENT_V1,
  RegisterTriggerSource,
} from "@trigger.dev/core";
import type { SecretReference, TriggerSource, TriggerSourceOption } from "@trigger.dev/database";
import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";
import { IngestSendEvent } from "../events/ingestSendEvent.server";
import { getSecretStore } from "../secrets/secretStore.server";
import { nanoid } from "nanoid";

export class ActivateSourceService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, jobId?: string, orphanedEvents?: Array<string>) {
    const triggerSource = await this.#prismaClient.triggerSource.findUniqueOrThrow({
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
        options: true,
        secretReference: true,
      },
    });

    const eventId = `${id}:${jobId ?? nanoid()}`;

    // TODO: support more channels
    switch (triggerSource.channel) {
      case "HTTP": {
        await this.#activateHttpSource(
          triggerSource.environment,
          triggerSource,
          triggerSource.options,
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
    options: Array<TriggerSourceOption>,
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

    switch (triggerSource.version) {
      case "1": {
        const eventNames = triggerSource.active
          ? options.filter((e) => e.registered).map((e) => e.name)
          : options.map((e) => e.name);
        const missingEvents = triggerSource.active
          ? options.filter((e) => !e.registered).map((e) => e.name)
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
          name: REGISTER_SOURCE_EVENT_V1,
          source: "trigger.dev",
          payload: {
            id: triggerSource.id,
            source,
            events: eventNames,
            missingEvents,
            orphanedEvents: orphanedEvents ?? [],
          },
        });

        break;
      }
      case "2": {
        const events = triggerSource.active
          ? options.filter((e) => e.registered).map((e) => ({ name: e.name, value: e.value }))
          : options.map((e) => ({ name: e.name, value: e.value }));

        const missingEvents = triggerSource.active
          ? options.filter((e) => !e.registered).map((e) => ({ name: e.name, value: e.value }))
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
            events: events,
            missingEvents,
            orphanedEvents: orphanedEvents ?? [],
          },
        });
        break;
      }
    }
  }
}
