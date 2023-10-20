import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, verifyRequestSignature } from "@trigger.dev/sdk";
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
  //only needed for strange APIs like WhatsApp which don't setup the webhook until you pass the test
  sendResponse: {
    ifRequest: {
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
  verify: async (request, context) => {
    return verifyRequestSignature({
      request,
      secret: context.secret,
      headerName: "X-Signature-SHA256",
    });
  },
  //todo would it be better to just have a "preprocess" function that returns the event?
});

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
