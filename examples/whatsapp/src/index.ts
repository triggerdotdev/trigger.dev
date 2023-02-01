import { Trigger } from "@trigger.dev/sdk";
import {
  events,
  sendImage,
  sendLocation,
  sendReaction,
  sendTemplate,
  sendText,
} from "@trigger.dev/whatsapp";

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

    const reactionResponse = await sendReaction("reaction", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      isReplyTo: event.message.id,
      emoji: "🥰",
    });

    const templateResponse = await sendTemplate("template-msg", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      template: "hello_world",
      languageCode: "en_US",
    });

    const textResponse = await sendText("text-msg", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      text: "Hello! This is a text sent automatically from https://www.trigger.dev",
    });

    const replyResponse = await sendText("reply-text-msg", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      text: "Hi, this is a reply to the automated message that was just sent",
      isReplyTo: textResponse.messages[0].id,
    });

    const imageResponse = await sendImage("image", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      url: "https://app.trigger.dev/emails/logo.png",
      caption: "This is a genius caption",
    });

    const locationResponse = await sendLocation("location", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      latitude: 37.422,
      longitude: -122.084,
      name: "Trigger.dev HQ",
      address: "123 Main St, San Francisco, CA 94105",
    });
  },
}).listen();
