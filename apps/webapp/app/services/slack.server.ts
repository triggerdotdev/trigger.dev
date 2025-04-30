import { WebClient } from "@slack/web-api";
import { env } from "~/env.server";
import { logger } from "./logger.server";

const slack = new WebClient(env.SLACK_BOT_TOKEN);

type SendNewOrgMessageParams = {
  orgName: string;
  whyUseUs: string;
  userEmail: string;
};

export async function sendNewOrgMessage({ orgName, whyUseUs, userEmail }: SendNewOrgMessageParams) {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_SIGNUP_REASON_CHANNEL_ID) {
    return;
  }
  try {
    await slack.chat.postMessage({
      channel: env.SLACK_SIGNUP_REASON_CHANNEL_ID,
      text: `New org created: ${orgName}`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "New org created" },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: `*Org name:* ${orgName}` },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: `*What problem are you trying to solve?*\n${whyUseUs}` },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Created by: ${userEmail}` }],
        },
      ],
    });
  } catch (error) {
    logger.error("Error sending data to Slack when creating an org:", { error });
  }
}
