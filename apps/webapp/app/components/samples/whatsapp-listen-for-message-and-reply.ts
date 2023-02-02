export const whatsappListenForMessageAndReply = `
import { Trigger } from "@trigger.dev/sdk";
import { events, sendReaction, sendText } from "@trigger.dev/whatsapp";

new Trigger({
  id: "whatsapp-webhook",
  name: "Listen for WhatsApp messages and reply",
  apiKey: "<my_api_key>",
  //this listens for all WhatsApp messages sent to your WhatsApp Business account
  on: events.messageEvent({
    accountId: "<your_account_id>",
  }),
  run: async (event, ctx) => {
    //these logs will appear on the run page
    await ctx.logger.info(\`Message data\`, event.message);
    await ctx.logger.info(\`Phone number\`, event.contacts[0]);

    //add a 🥰 reaction to the original message
    const reactionResponse = await sendReaction("reaction", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      isReplyTo: event.message.id,
      emoji: "🥰",
    });

    //send a text message in response
    const textResponse = await sendText("text-msg", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      text: "Hello! This is a text sent automatically from https://www.trigger.dev",
    });

    //we support all other types of WhatsApp messages (audio, video, document, location, etc)
  },
}).listen();
`;


