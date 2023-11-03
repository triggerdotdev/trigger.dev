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
      if (searchParams.get("hub.verify_token") !== process.env.WHATSAPP_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response(searchParams.get("hub.challenge") ?? "OK", { status: 200 });
    },
  },
  verify: async (request) => {
    const text = await request.text();
    const bodyDigest = crypto
      .createHmac("sha256", process.env.WHATSAPP_APP_SECRET!)
      .update(text)
      .digest("hex");
    const signature = request.headers.get("x-hub-signature-256")?.replace("sha256=", "") ?? "";

    return { success: signature === bodyDigest };
  },
});

client.defineJob({
  id: "http-whatsapp",
  name: "HTTP WhatsApp",
  version: "1.1.0",
  enabled: true,
  trigger: whatsApp.onRequest(),
  run: async (request, io, ctx) => {
    const body = await request.json();
    await io.logger.info(`Body`, body);
  },
});

const caldotcom = client.defineHttpEndpoint({
  id: "cal.com",
  source: "cal.com",
  icon: "caldotcom",
  verify: async (request) => {
    const text = await request.text();
    const bodyDigest = crypto
      .createHmac("sha256", process.env.CALDOTCOM_SECRET!)
      .update(text)
      .digest("hex");
    const signature = request.headers.get("X-Cal-Signature-256")?.replace("sha256=", "") ?? "";

    return { success: signature === bodyDigest };
  },
});

client.defineJob({
  id: "http-caldotcom",
  name: "HTTP Cal.com",
  version: "1.0.0",
  enabled: true,
  trigger: caldotcom.onRequest(),
  run: async (request, io, ctx) => {
    const body = await request.json();
    await io.logger.info(`Body`, body);
  },
});

createExpressServer(client);
