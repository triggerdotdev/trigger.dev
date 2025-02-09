import { startActiveSpan } from "../tracer.server";
import { calculateNextScheduledTimestamp } from "../utils/calculateNextSchedule.server";
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

        return calculateNextScheduledTimestamp(
          instance.taskSchedule.generatorExpression,
          instance.taskSchedule.timezone,
          instance.lastScheduledTimestamp ?? new Date()
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

    // Enqueue triggering the task at the next scheduled timestamp
    await TriggerScheduledTaskService.enqueue(instanceId, nextScheduledTimestamp);
  }
}
