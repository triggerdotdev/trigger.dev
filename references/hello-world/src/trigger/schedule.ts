import { schedules } from "@trigger.dev/sdk/v3";

export const simpleSchedule = schedules.task({
  id: "simple-schedule",
  // Every other minute
  cron: "*/2 * * * *",
  run: async (payload, { ctx }) => {
    return {
      message: "Hello, world!",
    };
  },
});
