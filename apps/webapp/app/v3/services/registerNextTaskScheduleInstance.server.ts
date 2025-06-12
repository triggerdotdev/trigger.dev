import { startActiveSpan } from "../tracer.server";
import { calculateNextScheduledTimestampFromNow } from "../utils/calculateNextSchedule.server";
import { BaseService } from "./baseService.server";
import { TriggerScheduledTaskService } from "./triggerScheduledTask.server";

export class RegisterNextTaskScheduleInstanceService extends BaseService {
  public async call(instanceId: string) {
    const instance = await this._prisma.taskScheduleInstance.findFirst({
      where: {
        id: instanceId,
      },
      include: {
        taskSchedule: true,
        environment: true,
      },
    });

    if (!instance) {
      return;
    }

    const nextScheduledTimestamp = await startActiveSpan(
      "calculateNextScheduledTimestamp",
      async (span) => {
        span.setAttribute("task_schedule_id", instance.taskSchedule.id);
        span.setAttribute("task_schedule_instance_id", instance.id);
        span.setAttribute(
          "task_schedule_generator_expression",
          instance.taskSchedule.generatorExpression
        );
        span.setAttribute(
          "last_scheduled_timestamp",
          instance.lastScheduledTimestamp?.toISOString() ?? new Date().toISOString()
        );

        return calculateNextScheduledTimestampFromNow(
          instance.taskSchedule.generatorExpression,
          instance.taskSchedule.timezone
        );
      }
    );

    await this._prisma.taskScheduleInstance.update({
      where: {
        id: instanceId,
      },
      data: {
        nextScheduledTimestamp,
      },
    });

    // Enqueue triggering the task at the next scheduled timestamp in the new Redis worker
    await TriggerScheduledTaskService.enqueue(instanceId, nextScheduledTimestamp);
  }
}
