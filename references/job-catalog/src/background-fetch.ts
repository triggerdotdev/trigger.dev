import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger, invokeTrigger } from "@trigger.dev/sdk";
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
    name: "test.background-fetch.retry",
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

client.defineJob({
  id: "test-background-fetch",
  name: "Test background fetch",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "test.background-fetch",
    schema: z.object({
      url: z.string(),
    }),
  }),
  run: async (payload, io, ctx) => {
    return await io.backgroundFetch<any>("fetch", payload.url);
  },
});

client.defineJob({
  id: "test-background-fetch-rety-stuck-error",
  name: "Reproduce stuck error",
  version: "0.0.1",
  trigger: invokeTrigger({
    schema: z.object({
      url: z.string(),
    }),
  }),
  run: async (payload, io, ctx) => {
    await io.runTask(
      "test-background-fetch-retry",
      async (task) => {
        const response = await io.backgroundFetchResponse<any>(
          payload.url,
          payload.url,
          { method: "GET" },
          {
            timeout: {
              durationInMs: 1000,
              retry: {
                limit: 2,
                factor: 2,
                minTimeoutInMs: 3000, // 3 secs
                maxTimeoutInMs: 10000, // 10 secs
                randomize: true,
              },
            },
          }
        );

        console.log(`Got response`, response);
      },
      {
        retry: {
          limit: 4,
          factor: 1.8,
          minTimeoutInMs: 1500,
          maxTimeoutInMs: 30000,
          randomize: true,
        },
      }
    );

    await io.logger.info("Got here");
  },
});

createExpressServer(client);
