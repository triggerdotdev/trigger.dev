import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, verifyRequestSignature } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: true,
  ioLogLocalEnabled: true,
  logLevel: "info",
});

const whatsApp = client.defineHttpEndpoint({
  id: "whatsapp",
  source: "whatsapp.com",
  icon: "whatsapp",
  //only needed for strange APIs like WhatsApp which don't setup the webhook until you pass the test
  respondWith: {
    //don't trigger runs if they match this filter
    skipTriggeringRuns: true,
    filter: {
      method: ["GET"],
      query: {
        "hub.mode": [{ $startsWith: "sub" }],
      },
    },
    handler: async (request, verify) => {
      const searchParams = new URL(request.url).searchParams;
      if (searchParams.get("verify_token") !== process.env.WHATSAPP_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response(searchParams.get("challenge") ?? "OK", { status: 200 });
    },
  },
  verify: async (request) => {
    return verifyRequestSignature({
      request,
      secret: process.env.WHATSAPP_SECRET!,
      headerName: "X-Signature-SHA256",
      algorithm: "sha256",
    });
  },
});

client.defineJob({
  id: "http-whatsapp",
  name: "HTTP WhatsApp",
  version: "1.0.0",
  enabled: true,
  trigger: whatsApp.onRequest({ filter: { body: { event: ["message"] } } }),
  run: async (request, io, ctx) => {
    const body = await request.json();
    const { event } = body;
    await io.logger.info(`Received event: ${event}`);
  },
});

createExpressServer(client);
