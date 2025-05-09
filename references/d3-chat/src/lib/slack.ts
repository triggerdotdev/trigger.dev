import { WebClient } from "@slack/web-api";
import { logger } from "@trigger.dev/sdk";

// Initialize the Slack client
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

type SendApprovalMessageParams = {
  query: string;
  userId: string;
  tokenId: string;
  publicAccessToken: string;
  input: string;
};

export async function sendSQLApprovalMessage({
  query,
  userId,
  tokenId,
  publicAccessToken,
  input,
}: SendApprovalMessageParams) {
  return await logger.trace(
    "sendSQLApprovalMessage",
    async (span) => {
      const response = await slack.chat.postMessage({
        channel: process.env.SLACK_CHANNEL_ID!,
        text: `SQL Query Approval Required for user ${userId}`, // Fallback text for notifications
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "🚨 SQL Query Approval Required",
              emoji: true,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `*Requested by:* <@${userId}>`,
              },
            ],
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*User Request:*\n" + input,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Generated Query:*\n```sql\n" + query + "\n```",
            },
          },
          {
            type: "actions",
            block_id: "sql_approval_actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Approve ✅",
                  emoji: true,
                },
                style: "primary",
                value: JSON.stringify({
                  tokenId,
                  publicAccessToken,
                  action: "approve",
                }),
                action_id: "sql_approve",
              },
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Deny ❌",
                  emoji: true,
                },
                style: "danger",
                value: JSON.stringify({
                  tokenId,
                  publicAccessToken,
                  action: "deny",
                }),
                action_id: "sql_deny",
              },
            ],
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "⚠️ This action cannot be undone",
              },
            ],
          },
        ],
      });

      return response;
    },
    {
      icon: "tabler-brand-slack",
    }
  );
}
