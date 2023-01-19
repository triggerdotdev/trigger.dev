import type { SchedulerSource } from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ScheduleNextEvent } from "../scheduler/scheduleNextEvent.server";

export class RegisterSchedulerSource {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const schedulerSource = await this.#prismaClient.schedulerSource.findUnique(
      {
        where: {
          id,
        },
      }
    );

    if (!schedulerSource) {
      return true;
    }

    if (schedulerSource.status !== "CREATED") {
      return true;
    }

    console.log("[RegisterSchedulerSource] registering external source", {
      schedulerSource,
    });

    return this.#registerScheduler(schedulerSource);
  }

  async #registerScheduler(schedulerSource: SchedulerSource) {
    const scheduleNextEvent = new ScheduleNextEvent();

    const isScheduled = await scheduleNextEvent.call(schedulerSource);

    if (!isScheduled) {
      return false;
    }

    await this.#prismaClient.schedulerSource.update({
      where: {
        id: schedulerSource.id,
      },
      data: {
        status: "READY",
        readyAt: new Date(),
      },
    });

    await this.#prismaClient.workflow.updateMany({
      where: {
        id: schedulerSource.workflowId,
      },
      data: {
        status: "READY",
      },
    });

    return true;
  }
}
