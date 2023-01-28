import { Trigger, customEvent, scheduleEvent } from "@trigger.dev/sdk";
import { slack } from "@trigger.dev/integrations";
import JSXSlack, {
  Actions,
  Blocks,
  Button,
  Section,
  Select,
  Option,
} from "jsx-slack";
import { z } from "zod";

new Trigger({
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
    const response = await slack.postMessage("send-to-slack", {
      channelName: "test-integrations",
      text: `New domain created: ${event.domain} by customer ${event.customerId} cc @Eric #general`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Hello, Assistant to the Regional Manager Dwight! *Michael Scott* wants to know where you'd like to take the Paper Company investors to dinner tonight.\n\n *Please select a restaurant:*",
          },
        },
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Farmhouse Thai Cuisine*\n:star::star::star::star: 1528 reviews\n They do have some vegan options, like the roti and curry, plus they have a ton of salad stuff and noodles can be ordered without meat!! They have something for everyone here",
          },
          accessory: {
            type: "image",
            image_url:
              "https://s3-media3.fl.yelpcdn.com/bphoto/c7ed05m9lC2EmA3Aruue7A/o.jpg",
            alt_text: "alt text for image",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Kin Khao*\n:star::star::star::star: 1638 reviews\n The sticky rice also goes wonderfully with the caramelized pork belly, which is absolutely melt-in-your-mouth and so soft.",
          },
          accessory: {
            type: "image",
            image_url:
              "https://s3-media2.fl.yelpcdn.com/bphoto/korel-1YjNtFtJlMTaC26A/o.jpg",
            alt_text: "alt text for image",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Ler Ros*\n:star::star::star::star: 2082 reviews\n I would really recommend the  Yum Koh Moo Yang - Spicy lime dressing and roasted quick marinated pork shoulder, basil leaves, chili & rice powder.",
          },
          accessory: {
            type: "image",
            image_url:
              "https://s3-media2.fl.yelpcdn.com/bphoto/DawwNigKJ2ckPeDeDM7jAg/o.jpg",
            alt_text: "alt text for image",
          },
        },
        {
          type: "divider",
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Farmhouse",
                emoji: true,
              },
              value: "click_me_123",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Kin Khao",
                emoji: true,
              },
              value: "click_me_123",
              url: "https://google.com",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Ler Ros",
                emoji: true,
              },
              value: "click_me_123",
              url: "https://google.com",
            },
          ],
        },
      ],
    });

    await ctx.waitFor("initial-wait", { seconds: 5 });

    await slack.postMessage("arnie", {
      username: "Arnie",
      icon_url:
        "https://www.themoviedb.org/t/p/w500/zEMhugsgXIpnQqO31GpAJYMUZZ1.jpg",
      channelName: "test-integrations",
      text: getRandomQuote(),
    });

    return {};
  },
}).listen();

function getRandomQuote() {
  const arnoldQuotes = [
    "I'll be back.",
    "Strength does not come from winning. Your struggles develop your strengths. When you go through hardships and decide not to surrender, that is strength.",
    "The mind is the limit. As long as the mind can envision the fact that you can do something, you can do it, as long as you really believe 100 percent.",
    "Success is not the key to happiness. Happiness is the key to success. If you love what you are doing, you will be successful.",
    "For me life is continuously being hungry. The meaning of life is not simply to exist, to survive, but to move ahead, to go up, to achieve, to conquer.",
    "The best activities for your health are pumping and humping.",
    "I have a love interest in every one of my films: a gun.",
    "You can have results or excuses, but not both.",
  ];

  return arnoldQuotes[Math.floor(Math.random() * arnoldQuotes.length)];
}

const BLOCK_ID = "issue.action.block";
const BLOCK_ID_RATING = "issue.rating.block";

//every minute see how your employees are doing, we don't recommend this frequency 😉
new Trigger({
  id: "slack-interactivity",
  name: "Testing Slack Interactivity",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: scheduleEvent({
    rateOf: {
      minutes: 1,
    },
  }),
  run: async (event, ctx) => {
    await slack.postMessage("jsx-test", {
      channelName: "test-integrations",
      //text appears in Slack notifications on mobile/desktop
      text: "How is your progress today?",
      //import and use JSXSlack to make creating rich messages much easier
      blocks: JSXSlack(
        <Blocks>
          <Section>How is your progress today?</Section>
          <Actions blockId={BLOCK_ID}>
            <Button value="blocked" actionId="status-blocked">
              I'm blocked
            </Button>
            <Button
              value="help"
              actionId="status-help"
              url="https://xkcd.com/1349/"
            >
              Get help
            </Button>
            <Select actionId="rating" placeholder="Rate it!">
              <Option value="5">5 {":star:".repeat(5)}</Option>
              <Option value="4">4 {":star:".repeat(4)}</Option>
              <Option value="3">3 {":star:".repeat(3)}</Option>
              <Option value="2">2 {":star:".repeat(2)}</Option>
              <Option value="1">1 {":star:".repeat(1)}</Option>
            </Select>
          </Actions>
        </Blocks>
      ),
    });
  },
}).listen();

const BLOCK_ID_2 = "release.action.block";

new Trigger({
  id: "slack-block-interaction",
  name: "Slack Block Interaction",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: slack.events.blockActionInteraction({
    blockId: BLOCK_ID,
    actionId: ["status-blocked", "status-help", "rating"],
  }),
  run: async (event, ctx) => {
    //create promises from all the actions
    const promises = event.actions.map((action) => {
      switch (action.action_id) {
        case "status-blocked": {
          //the user is blocked so add a 😢 emoji as a reaction
          if (event.message) {
            return slack.addReaction("React to message", {
              name: "cry",
              timestamp: event.message.ts,
              channelId: event.channel.id,
            });
          }
        }
        case "status-help": {
          //the user needs help so add an 🆘 emoji as a reaction
          if (event.message) {
            return slack.addReaction("React to message", {
              name: "sos",
              timestamp: event.message.ts,
              channelId: event.channel.id,
            });
          }
        }
        case "rating": {
          if (action.type != "static_select") {
            throw new Error("This action should be a select");
          }

          //post the rating as a message that appears below the original,
          //only the user pressing the button will see this message
          return slack.postMessageResponse(
            "Added a comment to the issue",
            event.response_url,
            {
              text: `You rated your day ${action.selected_option.value} stars`,
              replace_original: false,
            }
          );
        }
        default:
          return Promise.resolve();
      }
    });

    await Promise.all(promises);
  },
}).listen();

new Trigger({
  id: "slack-block-interaction-2",
  name: "Slack Block Interaction 2",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: slack.events.blockActionInteraction({
    blockId: BLOCK_ID_2,
  }),
  run: async (event, ctx) => {
    if (!event.message) {
      ctx.logger.debug(`No message found`);
      return;
    }

    await slack.addReaction("React to message", {
      name: "thumbsup",
      timestamp: event.message.ts,
      channelId: event.channel.id,
    });
  },
}).listen();
