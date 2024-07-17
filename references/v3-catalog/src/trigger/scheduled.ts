import { logger, schedules, task } from "@trigger.dev/sdk/v3";

export const firstScheduledTask = schedules.task({
  id: "first-scheduled-task",
  //every other minute
  cron: "*/6 * * * *",
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

export const secondScheduledTask = schedules.task({
  id: "second-scheduled-task",
  cron: "0 */3 * * *",
  run: async (payload) => {},
});

export const manageSchedules = task({
  id: "manage-schedules",
  run: async (payload) => {
    const createdSchedule = await schedules.create({
      //The id of the scheduled task you want to attach to.
      task: firstScheduledTask.id,
      //The schedule in CRON format.
      cron: "* * * * *",
      deduplicationKey: `create-schedule-1718277290717`,
      timezone: "Asia/Tokyo",
    });
    logger.log("Created schedule", createdSchedule);

    const editedSchedule = await schedules.update(createdSchedule.id, {
      //The id of the scheduled task you want to attach to.
      task: firstScheduledTask.id,
      //The schedule in CRON format.
      cron: "* * * * *",
      timezone: "Europe/Athens",
    });
    logger.log("Edited schedule", editedSchedule);

    const sched = await schedules.retrieve(createdSchedule.id);
    logger.log("Retrieved schedule", sched);

    const allSchedules = await schedules.list();
    logger.log("All schedules", { allSchedules });

    const { timezones } = await schedules.timezones();
    logger.log("Timezones", { timezones });

    const withoutUtc = await schedules.timezones({ excludeUtc: true });
    logger.log("Timezones without UTC", { withoutUtc });
  },
});
