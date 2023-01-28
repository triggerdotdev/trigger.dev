import { Trigger, customEvent } from "@trigger.dev/sdk";
import { slack } from "@trigger.dev/integrations";
import { z } from "zod";

new Trigger({
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

    const response = await slack.postMessage("send-to-slack", {
      channelName: "test-integrations",
      text: `New domain created: ${event.domain} by customer ${event.customerId} cc @Eric #general`,
    });

    await ctx.waitFor("initial-wait", { seconds: 5 });

    const secondResponse = await slack.postMessage("send-to-slack-channel-id", {
      channelId: response.channel,
      text: `Sent using the channelId: ${response.channel}`,
    });

    return {};
  },
}).listen();

