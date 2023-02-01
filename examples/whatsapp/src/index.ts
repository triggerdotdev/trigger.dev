import { Trigger } from "@trigger.dev/sdk";
import { events, sendTemplate } from "@trigger.dev/whatsapp";

new Trigger({
  id: "whatsapp-webhook",
  name: "WhatsApp webhook",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.messageEvent({
    accountId: "114848614845931",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(`Message data`, event.message);
    await ctx.logger.info(`Phone number`, event.contacts[0]);

    const response = await sendTemplate("template-msg", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      template: "hello_world",
      languageCode: "en_US",
    });
  },
}).listen();
