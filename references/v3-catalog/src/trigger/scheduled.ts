import { logger, schedules, task } from "@trigger.dev/sdk/v3";

export const firstScheduledTask = schedules.task({
  id: "first-scheduled-task",
  run: async (payload) => {
    const distanceInMs =
      payload.timestamp.getTime() - (payload.lastTimestamp ?? new Date()).getTime();

    logger.log("First scheduled tasks", { payload, distanceInMs });
  },
});

export const createSchedules = task({
  id: "creates-schedules",
  run: async (payload) => {
    const createdSchedule = await schedules.create({
      //The id of the scheduled task you want to attach to.
      task: firstScheduledTask.id,
      //The schedule in CRON format.
      cron: "0 0 * * *",
      deduplicationKey: "my-deduplication-key",
    });
  },
});
