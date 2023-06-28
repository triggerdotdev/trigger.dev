import { client } from "@/trigger";
import { Slack } from "@trigger.dev/slack";
import { Job, cronTrigger } from "@trigger.dev/sdk";

const db = {
  getKpiSummary: async (date: Date) => {
    return {
      revenue: 23_269,
      orders: 1_234,
    };
  },
};

export const slack = new Slack({ id: "slack" });

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
