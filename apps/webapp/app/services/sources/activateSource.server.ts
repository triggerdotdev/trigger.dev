import {
  REGISTER_SOURCE_EVENT_V2,
  REGISTER_SOURCE_EVENT_V1,
  RegisterTriggerSource,
  RegisterSourceEventV1,
  RegisterSourceEventV2,
  RegisterSourceEventOptions,
  RegisteredOptionsDiff,
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

  public async call(id: string, jobId?: string, orphanedOptions?: Record<string, string[]>) {
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
          orphanedOptions
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
    orphanedOptions?: Record<string, string[]>
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

    switch (triggerSource.version) {
      case "1": {
        const events = triggerSource.active
          ? options.filter((e) => e.registered).map((e) => e.value)
          : options.map((e) => e.value);
        const missingEvents = triggerSource.active
          ? options.filter((e) => !e.registered).map((e) => e.value)
          : [];
        const orphanedEvents = orphanedOptions
          ? Object.values(orphanedOptions).flatMap((vals) => vals)
          : [];

        const payload: RegisterSourceEventV1 = {
          id: triggerSource.id,
          source,
          events,
          missingEvents,
          orphanedEvents,
        };

        await service.call(environment, {
          id: eventId,
          name: REGISTER_SOURCE_EVENT_V1,
          source: "trigger.dev",
          payload,
        });
        break;
      }
      case "2": {
        //group the options by the name
        const optionsRecord = options.reduce((acc, option) => {
          if (!acc[option.name]) {
            acc[option.name] = [];
          }

          acc[option.name].push(option);

          return acc;
        }, {} as Record<string, Array<TriggerSourceOption>>);

        //for each of the optionsRecord, create the diff
        const payloadOptions = Object.entries(optionsRecord).reduce(
          (acc, [key, value]) => ({
            ...acc,
            [key]: getOptionsDiff(triggerSource.active, orphanedOptions?.[key] ?? [], value),
          }),
          {} as Record<string, RegisteredOptionsDiff>
        ) as RegisterSourceEventOptions;

        const payload: RegisterSourceEventV2 = {
          id: triggerSource.id,
          source,
          options: payloadOptions,
        };

        await service.call(environment, {
          id: eventId,
          name: REGISTER_SOURCE_EVENT_V2,
          source: "trigger.dev",
          payload,
        });
      }
    }
  }
}

function getOptionsDiff(
  sourceIsActive: boolean,
  orphaned: string[],
  options: Array<TriggerSourceOption>
): RegisteredOptionsDiff {
  const desired = sourceIsActive
    ? options.filter((e) => e.registered).map((e) => e.value)
    : options.map((e) => e.value);
  const missing = sourceIsActive ? options.filter((e) => !e.registered).map((e) => e.value) : [];

  return {
    desired,
    missing,
    orphaned,
  };
}
