import { CustomEventSchema } from "@trigger.dev/common-schemas";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { Organization } from "~/models/organization.server";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { internalPubSub } from "~/services/messageBroker.server";

export class IngestEvent {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    payload: unknown,
    organization: Organization,
    environment: RuntimeEnvironment
  ) {
    const validation = CustomEventSchema.safeParse(payload);

    if (!validation.success) {
      return {
        status: "validationError" as const,
        errors: validation.error.flatten().fieldErrors,
      };
    }

    // Create a new event in the database
    const event = await this.#prismaClient.customEvent.create({
      data: {
        organization: {
          connect: {
            id: organization.id,
          },
        },
        environment: {
          connect: {
            id: environment.id,
          },
        },
        name: validation.data.name,
        timestamp: validation.data.timestamp,
        payload: validation.data.payload ?? {},
        context: validation.data.context ?? undefined,
      },
    });

    // Produce a message to the event bus
    await internalPubSub.publish(
      "CUSTOM_EVENT_CREATED",
      {
        id: event.id,
        name: event.name,
        payload: validation.data.payload,
        timestamp: event.timestamp.toISOString(),
        context: validation.data.context ?? {},
        status: event.status,
      },
      {
        "x-environment-id": environment.id,
      }
    );

    return {
      status: "success" as const,
      data: event,
    };
  }
}
