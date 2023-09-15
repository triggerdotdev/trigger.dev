import { client } from "@/trigger";
import { Job, cronTrigger } from "@trigger.dev/sdk";

client.defineJob({
  id: "test-cron-schedule-5",
  name: "Test Cron Schedule 5",
  version: "0.0.1",
  logLevel: "debug",
  trigger: cronTrigger({
    cron: "*/1 * * * *",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.debug("Hello cron schedule 2a", {
      payload,
      payload2: payload,
    });
  },
});
