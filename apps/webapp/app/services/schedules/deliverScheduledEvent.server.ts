import { SCHEDULED_EVENT, ScheduledPayload } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { NextScheduledEventService } from "./nextScheduledEvent.server";
import { IngestSendEvent } from "../events/ingestSendEvent.server";
import { InvokeDispatcherService } from "../events/invokeDispatcher.server";
import { logger } from "../logger.server";

export class DeliverScheduledEventService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, payload: ScheduledPayload) {
    return await $transaction(
      this.#prismaClient,
      async (tx) => {
        // first, deliver the event through the dispatcher
        const scheduleSource = await tx.scheduleSource.findUniqueOrThrow({
          where: {
            id,
          },
          include: {
            dispatcher: true,
            environment: {
              include: {
                organization: true,
                project: true,
              },
            },
            externalAccount: true,
          },
        });

        if (!scheduleSource.active) {
          return;
        }

        const eventId = `${scheduleSource.id}:${payload.ts.getTime()}`;

        // false prevents send event from delivering the event to dispatchers
        // since we are going to control that ourselves
        const eventService = new IngestSendEvent(tx, false);

        const eventRecord = await eventService.call(
          scheduleSource.environment,
          {
            id: eventId,
            name: SCHEDULED_EVENT,
            payload,
          },
          { accountId: scheduleSource.externalAccount?.identifier },
          {
            id: scheduleSource.key,
            metadata: scheduleSource.metadata,
          }
        );

        if (!eventRecord) {
          throw new Error(
            `Unable to create an event record when delivering scheduled event for scheduleSource.id = ${scheduleSource.id}`
          );
        }

        const invokeDispatcherService = new InvokeDispatcherService(tx);

        await invokeDispatcherService.call(scheduleSource.dispatcher.id, eventRecord.id);

        logger.debug("updating lastEventTimestamp", {
          id,
          lastEventTimestamp: payload.ts,
        });

        await tx.scheduleSource.update({
          where: {
            id,
          },
          data: {
            lastEventTimestamp: payload.ts,
          },
        });

        const nextScheduledEventService = new NextScheduledEventService(tx);

        await nextScheduledEventService.call(scheduleSource.id);
      },
      { timeout: 10000 }
    );
  }
}
