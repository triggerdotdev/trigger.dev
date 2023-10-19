import type { EventDispatcher, EventRecord } from "@trigger.dev/database";
import type { EventFilter } from "@trigger.dev/core";
import { EventFilterSchema, eventFilterMatches } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { workerQueue } from "../worker.server";

export class DeliverBatchedEventService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(ids: string[]) {
    await $transaction(
      this.#prismaClient,
      async (tx) => {
        const eventRecords = await tx.eventRecord.findMany({
          where: {
            id: { in: ids },
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

        if (!eventRecords.length) {
          throw new Error("No event records found.");
        }

        const environmentId = eventRecords[0].environmentId;

        if (!eventRecords.every((event) => event.environmentId === environmentId)) {
          throw new Error("Cross-environment batched events should not exist.");
        }

        const unique = (val: unknown, i: number, array: unknown[]) => array.indexOf(val) === i;

        const uniqueEventNames = eventRecords.map((event) => event.name).filter(unique);
        const uniqueEventSources = eventRecords.map((event) => event.source).filter(unique);

        const nameSourceCombinations: { name: string; source: string }[] = [];

        for (let nameIndex = 0; nameIndex < uniqueEventNames.length; nameIndex++) {
          for (let sourceIndex = 0; sourceIndex < uniqueEventSources.length; sourceIndex++) {
            nameSourceCombinations.push({
              name: uniqueEventNames[nameIndex],
              source: uniqueEventSources[sourceIndex],
            });
          }
        }

        type InvocableDispatcher = { dispatcherId: string; eventRecordIds: string[] };

        const batchDispatchersToInvoke: InvocableDispatcher[] = [];
        const nonBatchDispatchersToInvoke: InvocableDispatcher[] = [];

        for (const combination of nameSourceCombinations) {
          const matchingEvents = eventRecords.filter(
            (event) => event.name === combination.name && event.source === combination.source
          );

          if (!matchingEvents.length) {
            continue;
          }

          const possibleEventDispatchers = await tx.eventDispatcher.findMany({
            where: {
              environmentId,
              event: {
                has: combination.name,
              },
              source: combination.source,
              enabled: true,
              manual: false,
            },
          });

          logger.debug("Found possible event dispatchers", {
            possibleEventDispatchers,
            eventRecords: matchingEvents.map((event) => event.id),
          });

          // filter events that match dispatcher filters
          for (const eventDispatcher of possibleEventDispatchers) {
            const filteredEvents = matchingEvents.filter((event) =>
              this.#evaluateEventRule(eventDispatcher, event)
            );

            // don't invoke dispatchers without any events
            if (!filteredEvents.length) {
              continue;
            }

            const invocableDispatcher = {
              dispatcherId: eventDispatcher.id,
              eventRecordIds: filteredEvents.map((event) => event.id),
            };

            if (eventDispatcher.batch) {
              batchDispatchersToInvoke.push(invocableDispatcher);
            } else {
              nonBatchDispatchersToInvoke.push(invocableDispatcher);
            }
          }
        }

        const eventRecordIds = eventRecords.map((event) => event.id);

        if (!batchDispatchersToInvoke.length && !nonBatchDispatchersToInvoke.length) {
          logger.debug("No matching event dispatchers", {
            eventRecords: eventRecordIds,
          });

          return;
        }

        logger.debug("Found matching batch event dispatchers", { batchDispatchersToInvoke });

        await Promise.all(
          batchDispatchersToInvoke.map((dispatcher) => {
            return workerQueue.enqueue(
              "events.invokeDispatcher",
              {
                id: dispatcher.dispatcherId,
                eventRecordIds: dispatcher.eventRecordIds,
              },
              { tx }
            );
          })
        );

        logger.debug("Found matching non-batch event dispatchers", { nonBatchDispatchersToInvoke });

        await Promise.all(
          nonBatchDispatchersToInvoke.map(async (dispatcher) => {
            // sequentially enqueue single events to preserve order
            for (const eventRecordId of dispatcher.eventRecordIds) {
              await workerQueue.enqueue(
                "events.invokeDispatcher",
                {
                  id: dispatcher.dispatcherId,
                  eventRecordIds: [eventRecordId],
                },
                { tx }
              );
            }
          })
        );

        await tx.eventRecord.updateMany({
          where: {
            id: { in: eventRecordIds },
          },
          data: {
            deliveredAt: new Date(),
          },
        });
      },
      { timeout: 10000 }
    );
  }

  #evaluateEventRule(dispatcher: EventDispatcher, eventRecord: EventRecord): boolean {
    if (!dispatcher.payloadFilter && !dispatcher.contextFilter) {
      return true;
    }

    const payloadFilter = EventFilterSchema.safeParse(dispatcher.payloadFilter ?? {});

    const contextFilter = EventFilterSchema.safeParse(dispatcher.contextFilter ?? {});

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
    return eventFilterMatches(this.event, filter);
  }
}
