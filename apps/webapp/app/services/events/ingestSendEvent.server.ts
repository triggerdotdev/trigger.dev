import type { RawEvent, SendEventOptions } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, PrismaErrorSchema, prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { workerQueue } from "~/services/worker.server";
import { logger } from "../logger.server";
import { EventRecord, ExternalAccount } from "@trigger.dev/database";
import { Duration, RateLimiter } from "../rateLimiter.server";
import { Ratelimit } from "@upstash/ratelimit";
import { env } from "~/env.server";

type UpdateEventInput = {
  tx: PrismaClientOrTransaction;
  existingEventLog: EventRecord;
  reqEvent: RawEvent;
  deliverAt?: Date;
};

type CreateEventInput = {
  tx: PrismaClientOrTransaction;
  event: RawEvent;
  environment: AuthenticatedEnvironment;
  deliverAt?: Date;
  sourceContext?: { id: string; metadata?: any };
  externalAccount?: ExternalAccount;
  eventSource?: EventSource;
};

type EventSource = {
  httpEndpointId?: string;
  httpEndpointEnvironmentId?: string;
};

const EVENT_UPDATE_THRESHOLD_WINDOW_IN_MSECS = 5 * 1000; // 5 seconds

export class IngestSendEvent {
  #prismaClient: PrismaClientOrTransaction;
  #rateLimiter: RateLimiter;

  constructor(prismaClient: PrismaClientOrTransaction = prisma, private deliverEvents = true) {
    this.#prismaClient = prismaClient;
    this.#rateLimiter = new RateLimiter({
      keyPrefix: "ingestsendevent",
      limiter: Ratelimit.slidingWindow(
        env.INGEST_EVENT_RATE_LIMIT_MAX,
        env.INGEST_EVENT_RATE_LIMIT_WINDOW as Duration
      ),
    });
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
    sourceContext?: { id: string; metadata?: any },
    eventSource?: EventSource
  ) {
    try {
      const deliverAt = this.#calculateDeliverAt(options);

      if (!environment.organization.runsEnabled) {
        logger.debug("IngestSendEvent: Runs are disabled for this organization", environment);
        return;
      }

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

        const existingEventLog = await tx.eventRecord.findUnique({
          where: {
            eventId_environmentId: {
              eventId: event.id,
              environmentId: environment.id,
            },
          },
        });

        const eventLog = await (existingEventLog
          ? this.updateEvent({ tx, existingEventLog, reqEvent: event, deliverAt })
          : this.createEvent({
              tx,
              event,
              environment,
              deliverAt,
              sourceContext,
              externalAccount,
              eventSource,
            }));

        //rate limit
        const { success, reset, limit } = await this.#rateLimiter.limit(environment.organizationId);

        if (success) {
          await this.enqueueWorkerEvent(tx, eventLog);
        } else {
          logger.info("IngestSendEvent: Rate limit exceeded", {
            eventRecordId: eventLog.id,
            organizationId: environment.organizationId,
            reset,
            limit,
          });
          return;
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

      throw error;
    }
  }

  private async createEvent({
    tx,
    event,
    environment,
    deliverAt,
    sourceContext,
    externalAccount,
    eventSource,
  }: CreateEventInput) {
    const eventLog = await tx.eventRecord.create({
      data: {
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        eventId: event.id,
        name: event.name,
        timestamp: event.timestamp ?? new Date(),
        payload: event.payload ?? {},
        payloadType: event.payloadType,
        context: event.context ?? {},
        source: event.source ?? "trigger.dev",
        sourceContext,
        deliverAt: deliverAt,
        externalAccountId: externalAccount ? externalAccount.id : undefined,
        httpEndpointId: eventSource?.httpEndpointId,
        httpEndpointEnvironmentId: eventSource?.httpEndpointEnvironmentId,
      },
    });

    return eventLog;
  }

  private async updateEvent({ tx, existingEventLog, reqEvent, deliverAt }: UpdateEventInput) {
    if (!this.shouldUpdateEvent(existingEventLog)) {
      logger.debug(`not updating event for event id: ${existingEventLog.eventId}`);
      return existingEventLog;
    }

    const updatedEventLog = await tx.eventRecord.update({
      where: {
        eventId_environmentId: {
          eventId: existingEventLog.eventId,
          environmentId: existingEventLog.environmentId,
        },
      },
      data: {
        payload: reqEvent.payload ?? existingEventLog.payload,
        payloadType: reqEvent.payloadType,
        context: reqEvent.context ?? existingEventLog.context,
        deliverAt: deliverAt ?? new Date(),
      },
    });

    return updatedEventLog;
  }

  private shouldUpdateEvent(eventLog: EventRecord) {
    const thresholdTime = new Date(Date.now() + EVENT_UPDATE_THRESHOLD_WINDOW_IN_MSECS);

    return eventLog.deliverAt >= thresholdTime;
  }

  private async enqueueWorkerEvent(tx: PrismaClientOrTransaction, eventLog: EventRecord) {
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
  }
}
