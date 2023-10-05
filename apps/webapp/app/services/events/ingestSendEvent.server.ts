import type { RawEvent, SendEventOptions } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, PrismaErrorSchema, prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { workerQueue } from "~/services/worker.server";
import { logger } from "../logger.server";

export class IngestSendEvent {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma, private deliverEvents = true) {
    this.#prismaClient = prismaClient;
  }

  #calculateDeliverAt(options?: SendEventOptions) {
    // If deliverAt is a string and a valid date, convert it to a Date object
    if (options?.deliverAt) {
      return options?.deliverAt;
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
    options?: SendEventOptions,
    sourceContext?: { id: string; metadata?: any }
  ) {
    try {
      const deliverAt = this.#calculateDeliverAt(options);

      return await $transaction(this.#prismaClient, async (tx) => {
        const externalAccount = options?.accountId
          ? await tx.externalAccount.upsert({
              where: {
                environmentId_identifier: {
                  environmentId: environment.id,
                  identifier: options.accountId,
                },
              },
              create: {
                environmentId: environment.id,
                organizationId: environment.organizationId,
                identifier: options.accountId,
              },
              update: {},
            })
          : undefined;

        // Create a new event in the database
        const eventLog = await tx.eventRecord.create({
          data: {
            organizationId: environment.organizationId,
            projectId: environment.projectId,
            environmentId: environment.id,
            eventId: event.id,
            name: event.name,
            timestamp: event.timestamp ?? new Date(),
            payload: event.payload ?? {},
            context: event.context ?? {},
            source: event.source ?? "trigger.dev",
            sourceContext,
            deliverAt: deliverAt,
            externalAccountId: externalAccount ? externalAccount.id : undefined,
          },
        });

        if (this.deliverEvents) {
          // Produce a message to the event bus
          await workerQueue.enqueue(
            "deliverEvent",
            {
              id: eventLog.id,
            },
            { runAt: eventLog.deliverAt, tx, jobKey: `event:${eventLog.id}` }
          );
        }

        return eventLog;
      });
    } catch (error) {
      const prismaError = PrismaErrorSchema.safeParse(error);

      if (!prismaError.success) {
        logger.debug("Error parsing prisma error", {
          error,
          parseError: prismaError.error.format(),
        });

        throw error;
      }

      // If the error is a Prisma unique constraint error, it means that the event already exists
      if (prismaError.success && prismaError.data.code === "P2002") {
        logger.debug("Event already exists, finding and returning", { event, environment });

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
