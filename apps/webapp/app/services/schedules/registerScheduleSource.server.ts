import type { EventDispatcher } from ".prisma/client";
import { ScheduleMetadata } from "@trigger.dev/internal";
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
  }: {
    key: string;
    dispatcher: EventDispatcher;
    schedule: ScheduleMetadata;
  }) {
    return await $transaction(this.#prismaClient, async (tx) => {
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
          schedule,
          active: true,
        },
        update: {
          schedule,
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
