import { schedules } from "@trigger.dev/sdk/v3";

export const simpleSchedule = schedules.task({
  id: "simple-schedule",
  cron: "0 0 * * *",
  ttl: "30m",
  run: async (payload, { ctx }) => {
    return {
      message: "Hello, world!",
    };
  },
});
