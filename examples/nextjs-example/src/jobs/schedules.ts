import { client } from "@/trigger";
import { Job, cronTrigger } from "@trigger.dev/sdk";

new Job(client, {
  id: "test-cron-schedule-2",
  name: "Test Cron Schedule 2",
  version: "0.0.1",
  logLevel: "debug",
  trigger: cronTrigger({
    cron: "*/5 * * * *",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.debug("Hello cron schedule 2a", {
      payload,
      payload2: payload,
    });
  },
});
