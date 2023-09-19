import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

client.defineJob({
  id: "delays-example-1",
  name: "Delays Example 1",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "delays.example",
  }),
  run: async (payload, io, ctx) => {
    await io.wait("wait-1", 60);
  },
});

client.defineJob({
  id: "delays-example-2",
  name: "Delays Example 2 - Long Delay",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "delays.example.long",
  }),
  run: async (payload, io, ctx) => {
    await io.wait("wait-1", 60 * 30);
  },
});

createExpressServer(client);
