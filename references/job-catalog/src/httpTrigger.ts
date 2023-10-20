import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient } from "@trigger.dev/sdk";
import crypto from "crypto";
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
    //todo turn this into a function
    const signature = Buffer.from(request.headers.get("X-Signature-SHA256") || "", "utf8");
    const hmac = crypto.createHmac("sha256", context.secret ?? "");
    const rawBody = await request.text();
    const digest = Buffer.from("sha256" + "=" + hmac.update(rawBody).digest("hex"), "utf8");

    const isAllowed =
      signature.length === digest.length && crypto.timingSafeEqual(digest, signature);

    return isAllowed;
  },
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
