import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger, intervalTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

// This job is misconfigured because it has an interval trigger with a 1 second interval, minimum is 60 seconds
client.defineJob({
  id: "disallowed-interval",
  name: "Disallowed Interval",
  version: "0.0.2",
  trigger: intervalTrigger({
    seconds: 0,
  }),
  run: async (payload, io, ctx) => {},
});

createExpressServer(client);
