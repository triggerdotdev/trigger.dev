import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const whatsApp = client.defineHttpTrigger({
  name: "",
  schema: z.object({
    message: z.string(),
  }),
});

client.defineJob({
  id: "event-example-1",
  name: "Event Example 1",
  version: "1.0.0",
  enabled: true,
  trigger: whatsApp,
  run: async (payload, io, ctx) => {
    //         ^?
  },
});

createExpressServer(client);
