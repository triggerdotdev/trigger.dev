import { Trigger, customEvent } from "@trigger.dev/sdk";
import { slack } from "@trigger.dev/integrations";
import { z } from "zod";

const trigger = new Trigger({
  id: "send-to-slack-on-new-domain",
  name: "Send to Slack on new domain",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "domain.created",
    schema: z.object({
      id: z.string(),
      customerId: z.string(),
      domain: z.string(),
    }),
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(
      "Received domain.created event, waiting for 1 minutes..."
    );

    await ctx.waitFor("initial-wait", { minutes: 1 });
    await ctx.waitUntil("initial-wait-until", new Date(Date.now() + 1000 * 60));

    await ctx.logger.info("Posting to Slack...");

    const response = await slack.postMessage("send-to-slack", {
      channel: "test-integrations",
      text: `New domain created: ${event.domain} by customer ${event.customerId}`,
    });

    await ctx.logger.info("Posted to Slack!");

    return response.message;
  },
});

trigger.listen();
