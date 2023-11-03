import crypto from "crypto";
import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, verifyRequestSignature } from "@trigger.dev/sdk";
import Stripe from "stripe";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: true,
  ioLogLocalEnabled: true,
  logLevel: "info",
});

//WhatsApp
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

//Cal.com
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

//Stripe
const stripe = client.defineHttpEndpoint({
  id: "stripe.com",
  source: "stripe.com",
  icon: "stripe",
  verify: async (request) => {
    const rawBody = await request.text();
    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return { success: false };
    }

    //we don't need an API Key because we're just using it to verify the signature
    const stripeClient = new Stripe("", { apiVersion: "2022-11-15" });

    try {
      //note that Stripe provide the secret, so this won't come from the Trigger.dev dashboard
      const event = stripeClient.webhooks.constructEvent(
        rawBody,
        signature,
        process.env.STRIPE_SECRET!
      );

      return { success: true };
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : JSON.stringify(error),
      };
    }
  },
});

client.defineJob({
  id: "http-stripe",
  name: "HTTP Stripe",
  version: "1.0.0",
  enabled: true,
  trigger: stripe.onRequest({ filter: { body: { type: ["charge.succeeded"] } } }),
  run: async (request, io, ctx) => {
    const body = await request.json();
    await io.logger.info(`Body`, body);
  },
});

//GitHub
const github = client.defineHttpEndpoint({
  id: "github.com",
  source: "github.com",
  icon: "github",
  verify: async (request) => {
    const text = await request.text();
    const bodyDigest = crypto
      .createHmac("sha256", process.env.GITHUB_SECRET!)
      .update(text)
      .digest("hex");
    const signature = request.headers.get("x-hub-signature-256")?.replace("sha256=", "") ?? "";

    return { success: signature === bodyDigest };
  },
});

client.defineJob({
  id: "http-github",
  name: "HTTP GitHub",
  version: "1.0.0",
  enabled: true,
  trigger: github.onRequest({ filter: { body: { action: ["labeled"] } } }),
  run: async (request, io, ctx) => {
    const body = await request.json();
    await io.logger.info(`Body`, body);
  },
});

//todo Loops

createExpressServer(client);
