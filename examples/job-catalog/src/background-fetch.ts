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

client.defineJob({
  id: "test-background-fetch-retry",
  name: "Test background fetch retry",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "test.background-fetch",
    schema: z.object({
      url: z.string(),
      method: z.string().optional(),
      headers: z.record(z.string()).optional(),
      body: z.any().optional(),
      retry: z.any().optional(),
    }),
  }),
  run: async (payload, io, ctx) => {
    return await io.backgroundFetch<any>(
      "fetch",
      payload.url,
      {
        method: payload.method ?? "GET",
        headers: payload.headers,
        body: payload.body ? JSON.stringify(payload.body) : undefined,
      },
      payload.retry
    );
  },
});

createExpressServer(client);
