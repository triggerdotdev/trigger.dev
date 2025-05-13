import { schedules } from "@trigger.dev/sdk/v3";

export const simpleSchedule = schedules.task({
  id: "simple-schedule",
  cron: "0 0 * * *",
  run: async (payload, { ctx }) => {
    return {
      message: "Hello, world!",
    };
  },
});
