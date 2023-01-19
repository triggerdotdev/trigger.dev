import type { SchedulerSource, TriggerEvent } from ".prisma/client";
import {
  ScheduledEventPayloadSchema,
  ScheduleSourceSchema,
} from "@trigger.dev/common-schemas";
import { calculateNextScheduledEvent } from "~/utils/scheduler";
import { taskQueue } from "../messageBroker.server";

export class ScheduleNextEvent {
  async call(
    schedulerSource: SchedulerSource,
    fromEvent?: TriggerEvent
  ): Promise<boolean> {
    if (schedulerSource.status === "CANCELLED") {
      console.log(
        "[ScheduleNextEvent] unable to schedule next event because the scheduler source has been cancelled"
      );
      return false;
    }

    const source = ScheduleSourceSchema.parse(schedulerSource.schedule);

    const scheduledTime = calculateNextScheduledEvent(
      source,
      fromEvent
        ? ScheduledEventPayloadSchema.parse(fromEvent.payload)
        : undefined
    );

    const messageId = await taskQueue.publish(
      "DELIVER_SCHEDULED_EVENT",
      { externalSourceId: schedulerSource.id, payload: { scheduledTime } },
      {},
      { deliverAt: scheduledTime.getTime() }
    );

    return !!messageId;
  }
}
