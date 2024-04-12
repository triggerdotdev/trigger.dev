import { InitOutput, taskCatalog } from "@trigger.dev/core/v3";
import { Task, TaskOptions, createTask } from "./shared";

export type ScheduledTaskPayload = {
  scheduleId: string;
  timestamp: Date;
  lastTimestamp?: Date;
  externalId?: string;
  upcoming: Array<Date>;
};

export type AddScheduleOptions = {
  deduplicationKey?: string;
  externalId?: string;
  cron: string;
};

export type AddScheduleResult = {
  id: string;
};

export function task<TOutput, TInitOutput extends InitOutput>(
  params: TaskOptions<ScheduledTaskPayload, TOutput, TInitOutput>
): Task<ScheduledTaskPayload, TOutput> {
  const task = createTask(params);

  taskCatalog.updateTaskMetadata(task.id, {
    triggerSource: "schedule",
  });

  return task;
}
