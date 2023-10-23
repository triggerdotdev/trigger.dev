import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, verifyRequestSignature } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const whatsApp = client.defineHttpEndpoint({
  id: "whatsapp",
  source: "whatsapp.com",
  //only needed for strange APIs like WhatsApp which don't setup the webhook until you pass the test
  respondWith: {
    filter: {
      method: ["GET"],
    },
    handler: async (request, context) => {
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
      algorithm: "sha256",
    });
  },
});

client.defineJob({
  id: "event-example-1",
  name: "Event Example 1",
  version: "1.0.0",
  enabled: true,
  trigger: whatsApp.onRequest({ filter: { body: { event: ["message"] } } }),
  run: async (payload, io, ctx) => {
    //         ^?
    const { message } = payload.body;
    await io.logger.info(`Received message from ${message.from}`);
  },
});

createExpressServer(client);
