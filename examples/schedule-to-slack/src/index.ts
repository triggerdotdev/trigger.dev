import { Trigger, scheduleEvent } from "@trigger.dev/sdk";
import { slack } from "@trigger.dev/integrations";

const trigger = new Trigger({
  id: "schedule-to-slack",
  name: "Send to Slack every minute",
  apiKey: "trigger_development_vzNnO2DGBGcG",
  logLevel: "debug",
  on: scheduleEvent({ rateOf: { minutes: 1 } }),
  run: async (event, ctx) => {
    await ctx.logger.info("It's me, the annoying slack bot!");

    const response = await slack.postMessage("slaaaaaack", {
      channel: "test-integrations",
      text: `Hello, the time is ${event.scheduledTime}`,
    });

    return response.message;
  },
});

trigger.listen();
