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
  id: "whatsapp",
  hostname: "whatsapp.com",
  bodySchema: z.object({
    type: z.literal("message"),
    message: z.object({
      from: z.string(),
      timestamp: z.coerce.date(),
      context: z.object({
        id: z.string(),
        from: z.string(),
      }),
    }),
  }),
  //todo, this is confusing because verifying refers to when data is sent and checking the headers
  verify: {
    requestFilter: {
      method: ["GET"],
    },
    onRequest: async (request, context) => {
      const searchParams = new URL(request.url).searchParams;
      if (searchParams.get("verify_token") !== context.secret) {
        return new Response("Unauthorized", { status: 401 });
      }

      return new Response(searchParams.get("challenge") ?? "OK", { status: 200 });
    },
  },
});

//todo what about verifying the actual webhooks?!?!

client.defineJob({
  id: "event-example-1",
  name: "Event Example 1",
  version: "1.0.0",
  enabled: true,
  trigger: whatsApp,
  run: async (payload, io, ctx) => {
    const { message } = payload.body;
    await io.logger.info(`Received message from ${message.from}`);
  },
});

createExpressServer(client);
