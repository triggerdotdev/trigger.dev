import { customEvent, Trigger } from "@trigger.dev/sdk";
import * as slack from "@trigger.dev/slackv2";
import { z } from "zod";

new Trigger({
  id: "send-to-slack-v2",
  name: "Send to Slack v2",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "domain.created",
    schema: z.object({}),
  }),
  run: async (event, ctx) => {
    await slack.postMessage("send-to-slack", {
      channel: "test-integrations",
      text: `This is coming the slack-v2 example, and is using a workflow`,
    });
  },
}).listen();
