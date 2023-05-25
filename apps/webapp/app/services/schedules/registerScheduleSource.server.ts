import type { EventDispatcher } from ".prisma/client";
import {
  CronMetadata,
  IntervalMetadata,
  ScheduleMetadata,
} from "@trigger.dev/internal";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { NextScheduledEventService } from "./nextScheduledEvent.server";

export class RegisterScheduleSourceService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    key,
    dispatcher,
    schedule,
    accountId,
  }: {
    key: string;
    dispatcher: EventDispatcher;
    schedule: ScheduleMetadata;
    accountId?: string;
  }) {
    const validation = validateSchedule(schedule);

    if (!validation.valid) {
      throw new Error(validation.reason);
    }

    return await $transaction(this.#prismaClient, async (tx) => {
      const externalAccount = accountId
        ? await tx.externalAccount.findUniqueOrThrow({
            where: {
              environmentId_identifier: {
                environmentId: dispatcher.environmentId,
                identifier: accountId,
              },
            },
          })
        : undefined;

      const scheduleSource = await this.#prismaClient.scheduleSource.upsert({
        where: {
          key_environmentId: {
            key,
            environmentId: dispatcher.environmentId,
          },
        },
        create: {
          key,
          environmentId: dispatcher.environmentId,
          dispatcherId: dispatcher.id,
          schedule: {
            type: schedule.type,
            options: schedule.options,
          },
          active: true,
          metadata: schedule.metadata,
          externalAccountId: externalAccount ? externalAccount.id : undefined,
        },
        update: {
          schedule: {
            type: schedule.type,
            options: schedule.options,
          },
          metadata: schedule.metadata ?? {},
          externalAccountId: externalAccount ? externalAccount.id : undefined,
        },
      });

      if (scheduleSource.active && !scheduleSource.workerJobId) {
        const service = new NextScheduledEventService(tx);

        await service.call(scheduleSource.id);
      }

      return scheduleSource;
    });
  }
}

type ScheduleValidationResult =
  | {
      valid: true;
    }
  | {
      valid: false;
      reason: string;
    };

function validateSchedule(
  schedule: ScheduleMetadata
): ScheduleValidationResult {
  switch (schedule.type) {
    case "cron":
      return validateCron(schedule);
    case "interval":
      return validateInterval(schedule);
  }
}

function validateInterval(
  schedule: IntervalMetadata
): ScheduleValidationResult {
  if (schedule.options.seconds < 60) {
    return {
      valid: false,
      reason: "Interval must be greater than 60 seconds",
    };
  }

  return {
    valid: true,
  };
}

function validateCron(schedule: CronMetadata): ScheduleValidationResult {
  return {
    valid: true,
  };
}
