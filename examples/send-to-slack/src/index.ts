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
    const response = await slack.postMessage({
      channel: "test-integrations",
      text: `New domain created: ${event.domain} by customer ${event.customerId}`,
    });

    return response.message;
  },
});

trigger.listen();
