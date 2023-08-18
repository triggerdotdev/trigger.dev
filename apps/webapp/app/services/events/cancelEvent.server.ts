import type { EventDispatcher, EventRecord } from "@trigger.dev/database";
import type { EventFilter } from "@trigger.dev/core";
import { EventFilterSchema, eventFilterMatches } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { workerQueue } from "../worker.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";

export class CancelEventService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(environment: AuthenticatedEnvironment, eventId: string): Promise<EventRecord | undefined> {
    return await $transaction(
      this.#prismaClient,
      async (tx) => {
        const event = await tx.eventRecord.findFirst({
          select: {
            id: true,
            name: true,
            createdAt: true,
            updatedAt: true,
            environmentId: true,
            runs: {
              select: {
                id: true,
                status: true,
                startedAt: true,
                completedAt: true,
              },
            },
          },
          where: {
            id: eventId,
            environmentId: environment.id,
          },
        });

        if (!event) {
          return;
        }

        //update the cancelledAt column in the eventRecord table
        const updatedEvent = await prisma.eventRecord.update({
          where: { id: event.id },
          data: { cancelledAt: new Date() },
        });

        // Dequeue the event after the db has been updated
        await workerQueue.dequeue(event.id, { tx: prisma });

        return updatedEvent;
      },
      { timeout: 10000 }
    );
  }
}
