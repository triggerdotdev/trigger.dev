import { Trigger, webhookEvent, customEvent } from "@trigger.dev/sdk";

new Trigger({
  id: "typeform-webhook",
  name: "Typeform Webhook",
  apiKey: "trigger_development_qthXXiRnLJuM",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: webhookEvent({
    service: "typeform.com",
    eventName: "form_response",
  }),
  run: async (event, ctx) => {
    // Do something with the event
    await ctx.logger.info("Received event", event);
  },
}).listen();

new Trigger({
  id: "new-user",
  name: "New User",
  apiKey: "trigger_development_qthXXiRnLJuM",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "new.user",
  }),
  run: async (event, ctx) => {
    // Do something with the event
    await ctx.logger.info("Received event", event);
  },
}).listen();
