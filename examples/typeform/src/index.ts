import { Trigger } from "@trigger.dev/sdk";
import { events } from "@trigger.dev/typeform";

new Trigger({
  id: "typeform-webhook-3",
  name: "Typeform webhook example",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.formResponseEvent({
    form_id: "Wu9xVIt6",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(`Action was ${event.event_id}`, event.form_response);
    return {};
  },
}).listen();
