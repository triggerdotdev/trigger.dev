import { fromZodError } from "zod-validation-error";
import type { EventDispatcher, EventRecord } from "@trigger.dev/database";
import type { EventFilter } from "@trigger.dev/core";
import { EventFilterSchema, RequestWithRawBodySchema, eventFilterMatches } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { workerQueue } from "../worker.server";
import { ZodWorkerBatchEnqueueOptions } from "~/platform/zodWorker.server";

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
            event: {
              has: eventRecord.name,
            },
            source: eventRecord.source,
            enabled: true,
            manual: false,
          },
          include: {
            batcher: true,
          },
        });

        logger.debug("Found possible event dispatchers", {
          possibleEventDispatchers,
          eventRecord: eventRecord.id,
        });

        const matchingEventDispatchers = possibleEventDispatchers.filter((eventDispatcher) =>
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
          matchingEventDispatchers.map((eventDispatcher) => {
            if (eventDispatcher.batcher) {
              const { maxPayloads, runAt } = this.#getBatchEnqueueOptions(eventDispatcher.batcher);

              const jobKeyParts = [eventDispatcher.id];

              if (eventRecord.isTest) {
                jobKeyParts.push(String(eventRecord.isTest));
              }

              if (eventRecord.externalAccountId) {
                jobKeyParts.push(eventRecord.externalAccountId);
              }

              return workerQueue.batchEnqueue("events.invokeDispatchBatcher", [eventRecord.id], {
                tx,
                jobKey: jobKeyParts.join(":"),
                maxPayloads,
                runAt,
              });
            } else {
              return workerQueue.enqueue(
                "events.invokeDispatcher",
                {
                  id: eventDispatcher.id,
                  eventRecordId: eventRecord.id,
                },
                { tx }
              );
            }
          })
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

  #evaluateEventRule(dispatcher: EventDispatcher, eventRecord: EventRecord): boolean {
    if (!dispatcher.payloadFilter && !dispatcher.contextFilter) {
      return true;
    }

    if (
      dispatcher.externalAccountId &&
      dispatcher.externalAccountId !== eventRecord.externalAccountId
    ) {
      return false;
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

  #getBatchEnqueueOptions(batcherConfig?: {
    maxPayloads: number | null;
    maxInterval: number | null;
  }): Pick<ZodWorkerBatchEnqueueOptions, "maxPayloads" | "runAt"> {
    const DEFAULT_MAX_PAYLOADS = 10;
    const DEFAULT_MAX_INTERVAL_IN_SECONDS = 30;

    const MAX_PAYLOADS = 250;
    const MAX_INTERVAL_IN_SECONDS = 10 * 60;

    const maxPayloads = Math.min(batcherConfig?.maxPayloads ?? DEFAULT_MAX_PAYLOADS, MAX_PAYLOADS);

    const runAt = new Date(
      Date.now() +
        Math.min(
          batcherConfig?.maxInterval ?? DEFAULT_MAX_INTERVAL_IN_SECONDS,
          MAX_INTERVAL_IN_SECONDS
        ) *
          1000
    );

    return { maxPayloads, runAt };
  }
}

export class EventMatcher {
  event: EventRecord;

  constructor(event: EventRecord) {
    this.event = event;
  }

  public matches(filter: EventFilter) {
    switch (this.event.payloadType) {
      case "REQUEST": {
        const result = RequestWithRawBodySchema.safeParse(this.event.payload);

        if (!result.success) {
          logger.error("Invalid payload, not a valid Raw REQUEST", {
            payload: this.event.payload,
            error: fromZodError(result.error).message,
          });
          return false;
        }

        const contentType = result.data.headers["content-type"];

        if (contentType?.includes("application/json")) {
          const body = JSON.parse(result.data.rawBody);
          const requestPayload = {
            url: result.data.url,
            method: result.data.method,
            headers: result.data.headers,
            body,
          };

          const isMatch = eventFilterMatches(
            {
              context: this.event.context,
              payload: requestPayload,
            },
            filter
          );

          return isMatch;
        }

        return eventFilterMatches(result.data, filter);
      }
      default: {
        return eventFilterMatches(this.event, filter);
      }
    }
  }
}
