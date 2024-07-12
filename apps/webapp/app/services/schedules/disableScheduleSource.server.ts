import type { EventDispatcher } from "@trigger.dev/database";
import { $transaction, type PrismaClientOrTransaction, prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { DeliverScheduledEventService } from "./deliverScheduledEvent.server";

export class DisableScheduleSourceService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ key, dispatcher }: { key: string; dispatcher: EventDispatcher }) {
    const scheduleSourceExists = await this.#prismaClient.scheduleSource.findUnique({
      where: {
        key_environmentId: {
          key,
          environmentId: dispatcher.environmentId,
        },
      },
    });

    if (!scheduleSourceExists) {
      return;
    }

    return await $transaction(this.#prismaClient, async (tx) => {
      const scheduleSource = await this.#prismaClient.scheduleSource.update({
        where: {
          key_environmentId: {
            key,
            environmentId: dispatcher.environmentId,
          },
        },
        data: {
          active: false,
        },
      });

      await DeliverScheduledEventService.dequeue(scheduleSource.id, tx);

      return scheduleSource;
    });
  }
}
