import { createExpressServer } from "@trigger.dev/express";
import { Resend } from "@trigger.dev/resend";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const resend = new Resend({
  id: "resend-client",
  apiKey: process.env.RESEND_API_KEY!,
});

client.defineJob({
  id: "send-resend-email",
  name: "Send Resend Email",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "send.email",
    schema: z.object({
      to: z.union([z.string(), z.array(z.string())]),
      subject: z.string(),
      text: z.string(),
    }),
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    await io.resend.sendEmail("📧", {
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      from: "Trigger.dev <hello@email.trigger.dev>",
    });
  },
});

createExpressServer(client);
