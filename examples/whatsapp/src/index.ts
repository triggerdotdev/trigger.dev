import { Trigger } from "@trigger.dev/sdk";
import {
  events,
  sendAudio,
  sendContacts,
  sendDocument,
  sendImage,
  sendLocation,
  sendReaction,
  sendSticker,
  sendTemplate,
  sendText,
  sendVideo,
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

    const videoResponse = await sendVideo("video", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      url: "https://media.giphy.com/media/5i7umUqAOYYEw/giphy.mp4",
      caption: "OMGGGG CATTTT",
    });

    const audioResponse = await sendAudio("audio", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      url: "https://ssl.gstatic.com/dictionary/static/pronunciation/2022-03-02/audio/wi/wikipedia_en_gb_1.mp3",
    });

    const documentResponse = await sendDocument("doc", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      url: "https://upload.wikimedia.org/wikipedia/commons/2/20/Re_example.pdf",
      caption: "A pdf",
    });

    const stickerResponse = await sendSticker("stick", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      url: "https://www.tyntec.com/sites/default/files/2020-07/tyntec_rocket_sticker_512px_001_.webp",
    });

    const locationResponse = await sendLocation("location", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      latitude: 37.422,
      longitude: -122.084,
      name: "Trigger.dev HQ",
      address: "123 Main St, San Francisco, CA 94105",
    });

    const contactsResponse = await sendContacts("contacts", {
      fromId: event.metadata.phone_number_id,
      to: event.message.from,
      contacts: [
        {
          name: {
            first_name: "Matt",
            last_name: "Aitken",
            formatted_name: "Matt Aitken",
          },
          phones: [
            {
              phone: "+12345678901",
            },
          ],
        },
      ],
    });
  },
}).listen();
