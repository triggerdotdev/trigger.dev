import type { TriggerType } from ".prisma/client";
import type { DisplayProperties } from "@trigger.dev/integration-sdk";
import { ulid } from "ulid";
import type { PrismaClient } from "~/db.server";
import { prisma, Prisma } from "~/db.server";
import type { Organization } from "~/models/organization.server";
import { findEnvironmentByApiKey } from "~/models/runtimeEnvironment.server";
import { taskQueue } from "~/services/messageBroker.server";

export type IngestEventOptions = {
  id: string;
  type: TriggerType;
  name: string;
  service: string;
  timestamp?: string;
  payload: any;
  context?: any;
  apiKey?: string;
  isTest?: boolean;
  displayProperties?: DisplayProperties;
};

export class IngestEvent {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(options: IngestEventOptions, organization?: Organization) {
    const environment = options.apiKey
      ? await findEnvironmentByApiKey(options.apiKey)
      : undefined;

    if (!environment && !organization) {
      return {
        status: "error" as const,
        error: "No organization or environment found",
      };
    }

    const id = options.id ?? ulid();

    const organizationId = organization?.id ?? environment?.organizationId;

    try {
      // Create a new event in the database
      const event = await this.#prismaClient.triggerEvent.create({
        data: {
          id,
          organization: {
            connect: {
              id: organizationId,
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
          isTest: options.isTest ?? false,
          displayProperties: options.displayProperties,
        },
      });

      // Produce a message to the event bus
      await taskQueue.publish("EVENT_CREATED", {
        id: event.id,
      });

      return {
        status: "success" as const,
        data: event,
      };
    } catch (error) {
      // If the error is a Prisma unique constraint error, it means that the event already exists
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          status: "success" as const,
          data: await this.#prismaClient.triggerEvent.findUnique({
            where: {
              id,
            },
          }),
        };
      }

      return {
        status: "error" as const,
        error,
      };
    }
  }
}
