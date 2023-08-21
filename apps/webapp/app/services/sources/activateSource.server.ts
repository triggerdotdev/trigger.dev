import { REGISTER_SOURCE_EVENT, RegisterTriggerSource } from "@trigger.dev/core";
import type { SecretReference, TriggerSource, TriggerSourceEvent } from "@trigger.dev/database";
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
        events: true,
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

    //todo this needs to stay exactly the same for TriggerSources of version: "v1"
    //todo ExternalSource needs to be updated so it passes "v2" through
    //todo indexEndpoint needs to set the TriggerSource version to "v2" if it's passed through

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
