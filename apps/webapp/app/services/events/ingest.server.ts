import type { TriggerType } from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { Organization } from "~/models/organization.server";
import { findEnvironmentByApiKey } from "~/models/runtimeEnvironment.server";
import { internalPubSub } from "~/services/messageBroker.server";

export type IngestEventOptions = {
  id: string;
  type: TriggerType;
  name: string;
  service: string;
  timestamp?: string;
  payload: any;
  context?: any;
  apiKey?: string;
};

export class IngestEvent {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(options: IngestEventOptions, organization: Organization) {
    const environment = options.apiKey
      ? await findEnvironmentByApiKey(options.apiKey)
      : undefined;

    // Create a new event in the database
    const event = await this.#prismaClient.triggerEvent.create({
      data: {
        id: options.id,
        organization: {
          connect: {
            id: organization.id,
          },
        },
        environment: environment
          ? {
              connect: {
                id: environment.id,
              },
            }
          : undefined,
        name: options.name,
        timestamp: options.timestamp,
        payload: options.payload ?? {},
        context: options.context ?? undefined,
        service: options.service,
        type: options.type,
      },
    });

    // Produce a message to the event bus
    await internalPubSub.publish("EVENT_CREATED", {
      id: event.id,
    });

    return {
      status: "success" as const,
      data: event,
    };
  }
}
