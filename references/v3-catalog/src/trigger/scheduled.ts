import { logger, schedules } from "@trigger.dev/sdk/v3";

export const firstScheduledTask = schedules.task({
  id: "first-scheduled-task",
  run: async (payload) => {
    logger.log("First scheduled tasks", { payload });
  },
});
