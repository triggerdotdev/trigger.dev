import { calculateNextScheduledTimestamp } from "../utils/calculateNextSchedule.server";
import { BaseService } from "./baseService.server";
import { TriggerScheduledTaskService } from "./triggerScheduledTask.server";

export class RegisterNextTaskScheduleInstanceService extends BaseService {
  public async call(instanceId: string) {
    const instance = await this._prisma.taskScheduleInstance.findUnique({
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

    const nextScheduledTimestamp = calculateNextScheduledTimestamp(
      instance.taskSchedule.generatorExpression,
      instance.taskSchedule.timezone,
      instance.lastScheduledTimestamp ?? new Date()
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
