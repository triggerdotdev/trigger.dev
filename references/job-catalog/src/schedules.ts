import { createExpressServer } from "@trigger.dev/express";
import { Resend } from "@trigger.dev/resend";
import { TriggerClient, cronTrigger, intervalTrigger } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

client.defineJob({
  id: "schedule-example-1",
  name: "Schedule Example 1",
  version: "1.0.0",
  enabled: true,
  trigger: intervalTrigger({
    seconds: 60 * 3, // 3 minutes
  }),
  run: async (payload, io, ctx) => {
    await io.runTask("task-example-1", async () => {
      return {
        message: "Hello World",
      };
    });

    await io.wait("wait-1", 1);

    await io.logger.info("Hello World", { ctx });
  },
});

const resend = new Resend({
  id: "resend-client",
  apiKey: process.env.RESEND_API_KEY!,
});

client.defineJob({
  id: "weekly-kpi-report",
  name: "Weekly KPI report",
  version: "1.0.0",
  trigger: cronTrigger({
    // Every Friday at 5pm (UTC)
    cron: "0 17 * * 5",
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const kpis = await io.runTask("get-kpis", async () => {
      return await getKpiData();
    });

    const emailList = ["jen@whatever.com", "ann@whatever.com"];

    await io.resend.sendEmail("send-kpis", {
      to: emailList,
      subject: "Weekly KPI report",
      text: `Users: ${kpis.users}, Revenue: ${kpis.revenue}`,
      from: "Trigger.dev <hello@email.trigger.dev>",
    });
  },
});

async function getKpiData() {
  return {
    users: 100_000,
    revenue: 1_000_000,
  };
}

createExpressServer(client);
