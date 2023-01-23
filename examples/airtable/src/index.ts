import { Trigger } from "@trigger.dev/sdk";
import { airtable } from "@trigger.dev/integrations";

new Trigger({
  id: "airtable-webhook-1",
  name: "Airtable webhook: appBlf3KsalIQeMUo",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: airtable.events.all({
    baseId: "appBlf3KsalIQeMUo",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(`Received webhook!`);
    return event;
  },
}).listen();
