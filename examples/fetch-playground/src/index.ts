import { Trigger, customEvent } from "@trigger.dev/sdk";

import { z } from "zod";

const TOKEN = "abc123";

new Trigger({
  id: "fetch-playground",
  name: "Fetch Playground",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "playground.fetch",
    schema: z.object({
      url: z.string().default("http://localhost:8888"),
      path: z.string().default("/"),
      method: z
        .enum(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
        .default("GET"),
      headers: z.record(z.string()).optional(),
      body: z.any().optional(),
    }),
  }),
  run: async (event, ctx) => {
    await ctx.logger.info("Received the playground.fetch event", {
      event,
      wallTime: new Date(),
    });

    const response = await ctx.fetch("do-fetch", `${event.url}${event.path}`, {
      method: event.method,
      responseSchema: z.any(),
      headers: event.headers,
      body: event.body ? JSON.stringify(event.body) : undefined,
    });

    await ctx.logger.info("Received the fetch response", {
      response,
      wallTime: new Date(),
    });
  },
}).listen();
