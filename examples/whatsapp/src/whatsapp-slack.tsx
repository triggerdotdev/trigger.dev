/** @jsxImportSource jsx-slack */
import { Trigger } from "@trigger.dev/sdk";
import {
  events,
  sendText,
  getMediaUrl,
  MessageEventMessage,
} from "@trigger.dev/whatsapp";
import JSXSlack, {
  Actions,
  Blocks,
  Button,
  Section,
  Header,
  Context,
  Image,
  Video,
} from "jsx-slack";
import * as slack from "@trigger.dev/slack";

const SLACK_BLOCK_ID = "launch.modal";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeStyle: "short",
  dateStyle: "short",
});

new Trigger({
  id: "whatsapp-to-slack",
  name: "WhatsApp to Slack",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.messageEvent({
    accountId: "114848614845931",
  }),
  run: async (event, ctx) => {
    ctx.logger.debug("event", event);
    let messageBody = <></>;

    switch (event.message.type) {
      case "text": {
        messageBody = <Section>{event.message.text.body}</Section>;
        break;
      }
      case "image": {
        const mediaUrl = await getMediaUrl(`getImageUrl`, event.message.image);
        messageBody = (
          <Image src={mediaUrl} alt={event.message.image.caption ?? ""} />
        );
        break;
      }
      case "video": {
        const mediaUrl = await getMediaUrl(`getVideoUrl`, event.message.video);
        messageBody = <Section>{mediaUrl}</Section>;
        break;
      }
      default:
        messageBody = (
          <Section>Unsupported message type: {event.message.type}</Section>
        );
    }

    await slack.postMessage("jsx-test", {
      channelName: "test-integrations",
      //text appears in Slack notifications on mobile/desktop
      text: "How is your progress today?",
      //import and use JSXSlack to make creating rich messages much easier
      blocks: JSXSlack(
        <Blocks>
          <Header>From: {event.message.from}</Header>
          <Context>At: {dateFormatter.format(event.message.timestamp)}</Context>
          {messageBody}
          <Actions blockId={SLACK_BLOCK_ID}>
            <Button value="reply" actionId="reply">
              Reply
            </Button>
          </Actions>
        </Blocks>
      ),
    });
  },
}).listen();
