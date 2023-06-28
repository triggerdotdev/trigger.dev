import {
  CronMetadata,
  IntervalMetadata,
  ScheduleMetadata,
  ScheduleMetadataSchema,
} from "@trigger.dev/internal";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { parseExpression } from "cron-parser";
import { workerQueue } from "../worker.server";
import { logger } from "../logger.server";

export class NextScheduledEventService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    return await $transaction(this.#prismaClient, async (tx) => {
      const scheduleSource =
        await this.#prismaClient.scheduleSource.findUniqueOrThrow({
          where: {
            id,
          },
        });

      if (!scheduleSource.active) {
        return;
      }

      const schedule = ScheduleMetadataSchema.safeParse(
        scheduleSource.schedule
      );

      if (!schedule.success) {
        return;
      }

      const scheduleTime = calculateNextScheduledEvent(
        schedule.data,
        scheduleSource.lastEventTimestamp
      );

      logger.debug("enqueuing scheduled event", {
        scheduleSourceId: scheduleSource.id,
        scheduleTime,
        lastTimestamp: scheduleSource.lastEventTimestamp,
      });

      const workerJob = await workerQueue.enqueue(
        "events.deliverScheduled",
        {
          id: scheduleSource.id,
          payload: {
            ts: scheduleTime,
            lastTimestamp: scheduleSource.lastEventTimestamp ?? undefined,
          },
        },
        {
          runAt: scheduleTime,
          queueName: `scheduler:${scheduleSource.environmentId}`,
          tx,
        }
      );

      await this.#prismaClient.scheduleSource.update({
        where: {
          id: scheduleSource.id,
        },
        data: {
          workerJobId: workerJob.id,
        },
      });

      return scheduleSource;
    });
  }
}

// this should always return a date in the future
// if calculateNextStep returns a date in the past, call it again with the result as the previousTimestamp
function calculateNextScheduledEvent(
  schedule: ScheduleMetadata,
  previousTimestamp?: Date | null
): Date {
  let nextStep = calculateNextStep(schedule, previousTimestamp);

  while (nextStep.getTime() < new Date().getTime()) {
    nextStep = calculateNextStep(schedule, nextStep);
  }

  return nextStep;
}

function calculateNextStep(
  schedule: ScheduleMetadata,
  previousTimestamp?: Date | null
): Date {
  switch (schedule.type) {
    case "interval": {
      return calculateNextIntervalOfEvent(schedule, previousTimestamp);
    }
    case "cron": {
      return calculateNextCronEvent(schedule, previousTimestamp);
    }
  }
}

function calculateNextIntervalOfEvent(
  interval: IntervalMetadata,
  previousTimestamp?: Date | null
): Date {
  const now = previousTimestamp
    ? previousTimestamp.getTime()
    : new Date().getTime();

  return new Date(now + calculateDurationInMs(interval));
}

function calculateDurationInMs(schedule: IntervalMetadata): number {
  return schedule.options.seconds * 1000;
}

function calculateNextCronEvent(
  schedule: CronMetadata,
  previousTimestamp?: Date | null
): Date {
  return parseExpression(schedule.options.cron, {
    currentDate: previousTimestamp ? previousTimestamp : new Date(),
  })
    .next()
    .toDate();
}
