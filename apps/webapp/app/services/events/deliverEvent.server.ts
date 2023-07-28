import type { EventDispatcher, EventRecord } from "@trigger.dev/database";
import type { EventFilter } from "@trigger.dev/core";
import { EventFilterSchema } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { workerQueue } from "../worker.server";

export class DeliverEventService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    await $transaction(
      this.#prismaClient,
      async (tx) => {
        const eventRecord = await tx.eventRecord.findUniqueOrThrow({
          where: {
            id,
          },
          include: {
            environment: {
              include: {
                organization: true,
                project: true,
              },
            },
          },
        });

        const possibleEventDispatchers = await tx.eventDispatcher.findMany({
          where: {
            environmentId: eventRecord.environmentId,
            event: eventRecord.name,
            source: eventRecord.source,
            enabled: true,
            manual: false,
          },
        });

        logger.debug("Found possible event dispatchers", {
          possibleEventDispatchers,
          eventRecord: eventRecord.id,
        });

        const matchingEventDispatchers = possibleEventDispatchers.filter(
          (eventDispatcher) =>
            this.#evaluateEventRule(eventDispatcher, eventRecord)
        );

        if (matchingEventDispatchers.length === 0) {
          logger.debug("No matching event dispatchers", {
            eventRecord: eventRecord.id,
          });

          return;
        }

        logger.debug("Found matching event dispatchers", {
          matchingEventDispatchers,
          eventRecord: eventRecord.id,
        });

        await Promise.all(
          matchingEventDispatchers.map((eventDispatcher) =>
            workerQueue.enqueue(
              "events.invokeDispatcher",
              {
                id: eventDispatcher.id,
                eventRecordId: eventRecord.id,
              },
              { tx }
            )
          )
        );

        await tx.eventRecord.update({
          where: {
            id: eventRecord.id,
          },
          data: {
            deliveredAt: new Date(),
          },
        });
      },
      { timeout: 10000 }
    );
  }

  #evaluateEventRule(
    dispatcher: EventDispatcher,
    eventRecord: EventRecord
  ): boolean {
    if (!dispatcher.payloadFilter && !dispatcher.contextFilter) {
      return true;
    }

    const payloadFilter = EventFilterSchema.safeParse(
      dispatcher.payloadFilter ?? {}
    );

    const contextFilter = EventFilterSchema.safeParse(
      dispatcher.contextFilter ?? {}
    );

    if (!payloadFilter.success || !contextFilter.success) {
      logger.error("Invalid event filter", {
        payloadFilter,
        contextFilter,
      });
      return false;
    }

    const eventMatcher = new EventMatcher(eventRecord);

    return eventMatcher.matches({
      payload: payloadFilter.data,
      context: contextFilter.data,
    });
  }
}

export class EventMatcher {
  event: EventRecord;

  constructor(event: EventRecord) {
    this.event = event;
  }

  public matches(filter: EventFilter) {
    return patternMatches(this.event, filter);
  }
}

function patternMatches(payload: any, pattern: any): boolean {
  for (const [patternKey, patternValue] of Object.entries(pattern)) {
    const payloadValue = payload[patternKey];

    if (Array.isArray(patternValue)) {
      if (patternValue.length > 0 && !patternValue.includes(payloadValue)) {
        return false;
      }
    } else if (typeof patternValue === "object") {
      if (Array.isArray(payloadValue)) {
        if (!payloadValue.some((item) => patternMatches(item, patternValue))) {
          return false;
        }
      } else {
        if (!patternMatches(payloadValue, patternValue)) {
          return false;
        }
      }
    }
  }
  return true;
}
