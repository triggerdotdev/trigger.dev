import type { ScheduledEventPayload } from "@trigger.dev/common-schemas";
import { ulid } from "ulid";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { DispatchWorkflowRun } from "../events/dispatch.server";
import { ScheduleNextEvent } from "./scheduleNextEvent.server";

export class DeliverScheduledEvent {
  #prismaClient: PrismaClient;
  #scheduleNextEventService: ScheduleNextEvent = new ScheduleNextEvent();
  #dispatchWorkflowRunService: DispatchWorkflowRun = new DispatchWorkflowRun();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(
    schedulerSourceId: string,
    payload: ScheduledEventPayload
  ): Promise<boolean> {
    const schedulerSource = await this.#prismaClient.schedulerSource.findUnique(
      {
        where: {
          id: schedulerSourceId,
        },
        include: {
          organization: true,
          workflow: true,
          environment: true,
        },
      }
    );

    if (!schedulerSource || schedulerSource.status === "CANCELLED") {
      return true;
    }

    const eventRule = await this.#prismaClient.eventRule.findUnique({
      where: {
        workflowId_environmentId: {
          workflowId: schedulerSource.workflowId,
          environmentId: schedulerSource.environmentId,
        },
      },
    });

    if (!eventRule) {
      console.log(
        `No event rule found for workflow ${schedulerSource.workflowId} and environment ${schedulerSource.environmentId}`
      );

      return true;
    }

    if (!eventRule.enabled) {
      return true;
    }

    // 1. Create a TriggerEvent
    const triggerEvent = await this.#prismaClient.triggerEvent.create({
      data: {
        id: ulid(),
        service: "scheduler",
        name: "scheduled-event",
        type: "SCHEDULE",
        payload: JSON.parse(JSON.stringify(payload)),
        context: {},
        organizationId: schedulerSource.organizationId,
        environmentId: schedulerSource.environmentId,
      },
    });

    // 2. Create a run
    await this.#dispatchWorkflowRunService.call(
      schedulerSource.workflow,
      eventRule,
      triggerEvent,
      schedulerSource.environment
    );

    // 3. Schedule next event
    await this.#scheduleNextEventService.call(schedulerSource, triggerEvent);

    return true;
  }
}
