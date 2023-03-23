import type { SchedulerSource, TriggerEvent } from ".prisma/client";
import {
  ScheduledEventPayloadSchema,
  ScheduleSourceSchema,
} from "@trigger.dev/common-schemas";
import { calculateNextScheduledEvent } from "~/utils/scheduler";
import { logger } from "../logger";
import { taskQueue } from "../messageBroker.server";

export class ScheduleNextEvent {
  async call(
    schedulerSource: SchedulerSource,
    lastRunAt?: Date
  ): Promise<boolean> {
    // Just double checking that the scheduler source is not cancelled
    if (schedulerSource.status === "CANCELLED") {
      logger.debug(
        "[ScheduleNextEvent] unable to schedule next event because the scheduler source has been cancelled",
        { schedulerSource, lastRunAt }
      );
      return false;
    }

    const source = ScheduleSourceSchema.parse(schedulerSource.schedule);

    const scheduledTime = calculateNextScheduledEvent(source, lastRunAt);

    const messageId = await taskQueue.publish(
      "DELIVER_SCHEDULED_EVENT",
      {
        externalSourceId: schedulerSource.id,
        payload: {
          scheduledTime,
          lastRunAt,
        },
      },
      {},
      { deliverAt: scheduledTime.getTime() }
    );

    return !!messageId;
  }
}
