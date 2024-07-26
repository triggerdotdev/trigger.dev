import {
  CronMetadata,
  IntervalMetadata,
  ScheduleMetadata,
  ScheduleMetadataSchema,
} from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { parseExpression } from "cron-parser";
import { logger } from "../logger.server";
import { DeliverScheduledEventService } from "./deliverScheduledEvent.server";

export class NextScheduledEventService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    return await $transaction(this.#prismaClient, async (tx) => {
      const scheduleSource = await this.#prismaClient.scheduleSource.findUniqueOrThrow({
        where: {
          id,
        },
      });

      if (!scheduleSource.active) {
        return;
      }

      const schedule = ScheduleMetadataSchema.safeParse(scheduleSource.schedule);

      if (!schedule.success) {
        return;
      }

      const scheduleTime = calculateNextScheduledEvent(
        schedule.data,
        scheduleSource.lastEventTimestamp ?? scheduleSource.createdAt
      );

      logger.debug("enqueuing scheduled event", {
        scheduleSource,
        scheduleTime,
        lastTimestamp: scheduleSource.lastEventTimestamp,
      });

      await DeliverScheduledEventService.enqueue(
        scheduleSource.id,
        scheduleTime,
        {
          ts: scheduleTime,
          lastTimestamp: scheduleSource.lastEventTimestamp ?? undefined,
        },
        tx
      );

      return scheduleSource;
    });
  }
}

// this should always return a date in the future
// if calculateNextStep returns a date in the past, call it again with the result as the previousTimestamp
export function calculateNextScheduledEvent(
  schedule: ScheduleMetadata,
  previousTimestamp?: Date | null
): Date {
  switch (schedule.type) {
    case "interval": {
      return calculateFutureIntervalEvent(schedule, previousTimestamp);
    }
    case "cron": {
      return calculateFutureCronEvent(schedule);
    }
  }
}

function calculateFutureIntervalEvent(
  schedule: IntervalMetadata,
  previousDate?: Date | null
): Date {
  const now = Date.now();
  const interval = schedule.options.seconds * 1000;

  if (!previousDate) {
    return new Date(now + interval);
  }

  const past = +previousDate;

  const intervalsToAdd = Math.ceil((now - past) / interval);

  return new Date(past + interval * intervalsToAdd);
}

function calculateFutureCronEvent(schedule: CronMetadata): Date {
  return parseExpression(schedule.options.cron).next().toDate();
}
