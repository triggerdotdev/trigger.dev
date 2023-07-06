import { client } from "@/trigger";
import { Slack } from "@trigger.dev/slack";
import { Job, cronTrigger, eventTrigger } from "@trigger.dev/sdk";

const db = {
  getKpiSummary: async (date: Date) => {
    return {
      revenue: 23_269,
      orders: 1_234,
    };
  },
};

export const slack = new Slack({ id: "slack-6" });
export const slackMissing = new Slack({ id: "slack-7" });

new Job(client, {
  id: "slack-kpi-summary",
  name: "Slack kpi summary",
  version: "0.1.1",
  integrations: {
    slack,
  },
  trigger: cronTrigger({
    cron: "0 9 * * *", // 9am every day (UTC)
  }),
  run: async (payload, io, ctx) => {
    const { revenue } = await db.getKpiSummary(payload.ts);
    const response = await io.slack.postMessage("Slack 📝", {
      text: `Yesterday's revenue was $${revenue}`,
      channel: "C04GWUTDC3W",
    });

    return response;
  },
});

new Job(client, {
  id: "slack-auto-join",
  name: "Slack Auto Join",
  version: "0.1.1",
  integrations: {
    slack,
  },
  trigger: eventTrigger({
    name: "slack.auto_join",
  }),
  run: async (payload, io, ctx) => {
    const response = await io.slack.postMessage("Slack 📝", {
      channel: "C05G130TH4G",
      text: "Welcome to the team, Eric!",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Welcome to the team, Eric!`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `I'm here to help you get started with Trigger!`,
          },
        },
      ],
    });

    return response;
  },
});

new Job(client, {
  id: "slack-missing-integration",
  name: "Slack with missing integration",
  version: "0.1.1",
  integrations: {
    slack: slackMissing,
  },
  trigger: eventTrigger({
    name: "missing.integration",
  }),
  run: async (payload, io, ctx) => {
    const response = await io.slack.postMessage("message", {
      text: `There's no Slack connection, or is there?`,
      channel: "C04GWUTDC3W",
    });

    return response;
  },
});
