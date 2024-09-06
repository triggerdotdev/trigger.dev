import { SCHEDULED_EVENT, ScheduledPayload } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { NextScheduledEventService } from "./nextScheduledEvent.server";
import { IngestSendEvent } from "../events/ingestSendEvent.server";
import { InvokeDispatcherService } from "../events/invokeDispatcher.server";
import { logger } from "../logger.server";
import { workerQueue } from "../worker.server";

const DEFERRED_ENQUEUE_THRESHOLD_IN_SECONDS = 60 * 60 * 2 - 1; // 2 hours - 1 second

export class DeliverScheduledEventService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  // This runs every 10 minutes
  public static async scheduleImminentDeferredEvents() {
    // Find all deferred events that are due to be enqueued in the next hour
    const deferredEvents = await prisma.deferredScheduledEventService.findMany({
      where: {
        runAt: {
          lte: new Date(Date.now() + (DEFERRED_ENQUEUE_THRESHOLD_IN_SECONDS / 2) * 1000),
        },
      },
    });

    for (const deferredEvent of deferredEvents) {
      logger.debug("Enqueuing deferred scheduled event", {
        scheduleSourceId: deferredEvent.scheduleSourceId,
        runAt: deferredEvent.runAt,
      });

      try {
        await DeliverScheduledEventService.enqueue(
          deferredEvent.scheduleSourceId,
          deferredEvent.runAt,
          {
            ts: deferredEvent.runAt,
            lastTimestamp: deferredEvent.lastTimestamp ?? undefined,
          }
        );
      } catch (error) {
        logger.error("Error enqueuing deferred scheduled event", {
          scheduleSourceId: deferredEvent.scheduleSourceId,
          runAt: deferredEvent.runAt,
          error,
        });
      }
    }
  }

  public static async dequeue(id: string, tx: PrismaClientOrTransaction = prisma) {
    await tx.deferredScheduledEventService.deleteMany({
      where: {
        scheduleSourceId: id,
      },
    });

    await workerQueue.dequeue(`scheduled:${id}`);

    await tx.scheduleSource.update({
      where: {
        id,
      },
      data: {
        workerJobId: null,
      },
    });
  }

  public static async enqueue(
    id: string,
    runAt: Date,
    payload: ScheduledPayload,
    tx: PrismaClientOrTransaction = prisma
  ) {
    if (runAt.getTime() - Date.now() > DEFERRED_ENQUEUE_THRESHOLD_IN_SECONDS * 1000) {
      logger.debug("Deferring enqueueing events.deliverScheduled", {
        id,
        runAt,
        payload,
      });

      await tx.deferredScheduledEventService.upsert({
        where: {
          scheduleSourceId: id,
        },
        create: {
          scheduleSourceId: id,
          runAt,
          lastTimestamp: payload.lastTimestamp,
        },
        update: {
          runAt,
          lastTimestamp: payload.lastTimestamp,
        },
      });

      await tx.scheduleSource.update({
        where: {
          id,
        },
        data: {
          workerJobId: null,
          nextEventTimestamp: runAt,
        },
      });

      await workerQueue.dequeue(`scheduled:${id}`);
    } else {
      await tx.deferredScheduledEventService.deleteMany({
        where: {
          scheduleSourceId: id,
        },
      });

      const workerJob = await workerQueue.enqueue(
        "events.deliverScheduled",
        {
          id: id,
          payload,
        },
        {
          runAt,
          tx,
          jobKey: `scheduled:${id}`,
        }
      );

      await tx.scheduleSource.update({
        where: {
          id,
        },
        data: {
          workerJobId: workerJob?.id,
          nextEventTimestamp: runAt,
        },
      });
    }
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
