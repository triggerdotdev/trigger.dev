import { logger, task } from "@trigger.dev/sdk/v3";

export const sendSlackNotification = task({
  id: "send-slack-notification",
  run: async (payload: { message: string }) => {
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: payload.message }),
    });

    logger.info("Slack notification sent");
  },
});
