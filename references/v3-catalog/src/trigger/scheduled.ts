import { logger, schedules, task } from "@trigger.dev/sdk/v3";
import { log } from "node:console";

export const firstScheduledTask = schedules.task({
  id: "first-scheduled-task",
  run: async (payload) => {
    const distanceInMs =
      payload.timestamp.getTime() - (payload.lastTimestamp ?? new Date()).getTime();

    logger.log(payload.timezone);

    logger.log("First scheduled tasks", { payload, distanceInMs });

    const formatted = payload.timestamp.toLocaleString("en-US", {
      timeZone: payload.timezone,
    });

    logger.log(formatted);
  },
});

export const createSchedules = task({
  id: "creates-schedules",
  run: async (payload) => {
    const createdSchedule = await schedules.create({
      //The id of the scheduled task you want to attach to.
      task: firstScheduledTask.id,
      //The schedule in CRON format.
      cron: "* * * * *",
      deduplicationKey: `create-schedule-1718277290717`,
      timezone: "America/Los_Angeles",
    });
  },
});
