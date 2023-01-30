import { Trigger, scheduleEvent } from "@trigger.dev/sdk";
import * as slack from "@trigger.dev/slack";

const trigger = new Trigger({
  id: "schedule-to-slack-2",
  name: "Send to Slack every minute",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: scheduleEvent({ rateOf: { minutes: 1 } }),
  run: async (event, ctx) => {
    await ctx.logger.info("It's me, the annoying slack bot!");

    const response = await slack.postMessage("slaaaaaack", {
      channelName: "test-integrations",
      text: `Hello, the time is ${event.scheduledTime}, and I was last run at ${event.lastRunAt}!`,
    });

    return event;
  },
});

trigger.listen();
