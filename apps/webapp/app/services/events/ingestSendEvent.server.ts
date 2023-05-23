import type { RawEvent, SendEventOptions } from "@trigger.dev/internal";
import {
  $transaction,
  PrismaClient,
  PrismaClientOrTransaction,
} from "~/db.server";
import { PrismaErrorSchema, prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { workerQueue } from "~/services/worker.server";

export class IngestSendEvent {
  #prismaClient: PrismaClientOrTransaction;

  constructor(
    prismaClient: PrismaClientOrTransaction = prisma,
    private deliverEvents = true
  ) {
    this.#prismaClient = prismaClient;
  }

  #calculateDeliverAt(options?: SendEventOptions) {
    // If deliverAt is a string and a valid date, convert it to a Date object
    if (options?.deliverAt && typeof options.deliverAt === "string") {
      const deliverAt = new Date(options.deliverAt);

      if (deliverAt.toString() !== "Invalid Date") {
        return deliverAt;
      }
    }

    // deliverAfter is the number of seconds to wait before delivering the event
    if (options?.deliverAfter) {
      return new Date(Date.now() + options.deliverAfter * 1000);
    }

    return undefined;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    event: RawEvent,
    options?: SendEventOptions
  ) {
    try {
      const deliverAt = this.#calculateDeliverAt(options);

      return await $transaction(this.#prismaClient, async (tx) => {
        // Create a new event in the database
        const eventLog = await tx.eventRecord.create({
          data: {
            organization: {
              connect: {
                id: environment.organizationId,
              },
            },
            project: {
              connect: {
                id: environment.projectId,
              },
            },
            environment: {
              connect: {
                id: environment.id,
              },
            },
            eventId: event.id,
            name: event.name,
            timestamp: event.timestamp ?? new Date(),
            payload: event.payload ?? {},
            context: event.context ?? {},
            source: event.source ?? "trigger.dev",
            deliverAt: deliverAt,
          },
        });

        if (this.deliverEvents) {
          // Produce a message to the event bus
          await workerQueue.enqueue(
            "deliverEvent",
            {
              id: eventLog.id,
            },
            { runAt: eventLog.deliverAt, tx }
          );
        }

        return eventLog;
      });
    } catch (error) {
      const prismaError = PrismaErrorSchema.safeParse(error);
      // If the error is a Prisma unique constraint error, it means that the event already exists
      if (prismaError.success && prismaError.data.code === "P2002") {
        return this.#prismaClient.eventRecord.findUniqueOrThrow({
          where: {
            eventId_environmentId: {
              eventId: event.id,
              environmentId: environment.id,
            },
          },
        });
      }

      throw error;
    }
  }
}
