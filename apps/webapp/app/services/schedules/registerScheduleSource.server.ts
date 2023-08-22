import type { DynamicTrigger, EventDispatcher } from "@trigger.dev/database";
import { CronMetadata, IntervalMetadata, ScheduleMetadata } from "@trigger.dev/core";
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
    dynamicTrigger,
  }: {
    key: string;
    dispatcher: EventDispatcher;
    schedule: ScheduleMetadata;
    accountId?: string;
    dynamicTrigger?: DynamicTrigger;
  }) {
    const validatedSchedule = validateSchedule(schedule);

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

      const environment = await tx.runtimeEnvironment.findUniqueOrThrow({
        where: {
          id: dispatcher.environmentId,
        },
      });

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
            type: validatedSchedule.type,
            options: validatedSchedule.options,
          },
          active: environment.autoEnableInternalSources,
          metadata: schedule.metadata,
          externalAccountId: externalAccount ? externalAccount.id : undefined,
          dynamicTriggerId: dynamicTrigger ? dynamicTrigger.id : undefined,
        },
        update: {
          schedule: {
            type: validatedSchedule.type,
            options: validatedSchedule.options,
          },
          metadata: schedule.metadata ?? {},
          externalAccountId: externalAccount ? externalAccount.id : undefined,
          active: environment.autoEnableInternalSources,
        },
      });

      if (scheduleSource.active) {
        const service = new NextScheduledEventService(tx);

        await service.call(scheduleSource.id);
      }

      return scheduleSource;
    });
  }
}

function validateSchedule(schedule: ScheduleMetadata): ScheduleMetadata {
  switch (schedule.type) {
    case "cron":
      return validateCron(schedule);
    case "interval":
      return validateInterval(schedule);
  }
}

function validateInterval(schedule: IntervalMetadata): ScheduleMetadata {
  if (schedule.options.seconds < 60) {
    return {
      type: "interval",
      options: {
        seconds: 60,
      },
    };
  }

  return schedule;
}

function validateCron(schedule: CronMetadata): ScheduleMetadata {
  return schedule;
}
