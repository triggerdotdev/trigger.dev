import type { EventDispatcher, EventRecord } from ".prisma/client";
import type { EventFilter } from "@trigger.dev/internal";
import { EventFilterSchema } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger";
import { workerQueue } from "../worker.server";

export class DeliverEventService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const eventRecord = await this.#prismaClient.eventRecord.findUniqueOrThrow({
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

    const possibleEventDispatchers =
      await this.#prismaClient.eventDispatcher.findMany({
        where: {
          environmentId: eventRecord.environmentId,
          event: eventRecord.name,
          source: eventRecord.source,
          enabled: true,
        },
      });

    logger.debug("Found possible event dispatchers", {
      possibleEventDispatchers,
      eventRecord: eventRecord.id,
    });

    const matchingEventDispatchers = possibleEventDispatchers.filter(
      (eventDispatcher) => this.#evaluateEventRule(eventDispatcher, eventRecord)
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
        workerQueue.enqueue("events.invokeDispatcher", {
          id: eventDispatcher.id,
          eventRecordId: eventRecord.id,
        })
      )
    );

    await this.#prismaClient.eventRecord.update({
      where: {
        id: eventRecord.id,
      },
      data: {
        deliveredAt: new Date(),
      },
    });
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
