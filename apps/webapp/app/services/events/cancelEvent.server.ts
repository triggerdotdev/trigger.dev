import type { EventRecord } from "@trigger.dev/database";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";

export class CancelEventService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    eventId: string
  ): Promise<EventRecord | undefined> {
    return await $transaction(
      this.#prismaClient,
      async (tx) => {
        const event = await tx.eventRecord.findUnique({
          select: {
            id: true,
            name: true,
            createdAt: true,
            updatedAt: true,
            environmentId: true,
            cancelledAt: true,
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
            eventId_environmentId: {
              eventId: eventId,
              environmentId: environment.id,
            },
          },
        });

        if (!event) {
          return;
        }

        if (event.cancelledAt) {
          return event;
        }

        //update the cancelledAt column in the eventRecord table
        const updatedEvent = await prisma.eventRecord.update({
          where: { id: event.id },
          data: { cancelledAt: new Date() },
        });

        // Dequeue the event after the db has been updated
        await workerQueue.dequeue(`event:${event.id}`, { tx: prisma });

        return updatedEvent;
      },
      { timeout: 10000 }
    );
  }
}
