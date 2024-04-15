import { parseExpression } from "cron-parser";
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
      instance.taskSchedule.cron,
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

  public nextScheduledTimestamps(cron: string, lastScheduledTimestamp: Date, count: number = 1) {
    const result: Array<Date> = [];
    let nextScheduledTimestamp = lastScheduledTimestamp;

    for (let i = 0; i < count; i++) {
      nextScheduledTimestamp = calculateNextScheduledTimestamp(cron, nextScheduledTimestamp);

      result.push(nextScheduledTimestamp);
    }

    return result;
  }
}

function calculateNextScheduledTimestamp(schedule: string, lastScheduledTimestamp: Date) {
  let nextStep = calculateNextStep(schedule, lastScheduledTimestamp);

  while (nextStep.getTime() < Date.now()) {
    nextStep = calculateNextStep(schedule, nextStep);
  }

  return nextStep;
}

function calculateNextStep(schedule: string, currentDate: Date) {
  return parseExpression(schedule, {
    currentDate,
    utc: true,
  })
    .next()
    .toDate();
}
