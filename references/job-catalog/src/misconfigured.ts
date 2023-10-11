import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, intervalTrigger } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

// This job is misconfigured because the interval trigger is less than 60s
client.defineJob({
  id: "bad-interval",
  name: "Bad Interval",
  version: "0.0.2",
  trigger: intervalTrigger({
    seconds: 50,
  }),
  run: async (payload, io, ctx) => {},
});

// This job is misconfigured because it has no name
//@ts-ignore
client.defineJob({
  id: "bad-cron",
  // name: "Bad CRON expression",
  version: "0.0.2",
  trigger: intervalTrigger({
    seconds: 90,
  }),
  run: async (payload, io, ctx) => {},
});

createExpressServer(client);
