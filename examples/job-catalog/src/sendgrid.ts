import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { createExpressServer } from "@trigger.dev/express";
import { z } from "zod";
import { SendGrid } from "@trigger.dev/sendgrid";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const sendgrid = new SendGrid({
  id: "sendgrid-client",
  apiKey: process.env.SENDGRID_API_KEY!,
});

client.defineJob({
  id: "send-Sendgrid-email",
  name: "Send Sendgrid Email",
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
    sendgrid,
  },
  run: async (payload, io, ctx) => {
    await io.sendgrid.sendEmail("📧", {
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      //this email must be verified in SendGrid, otherwise you'll get a forbidden error
      from: process.env.SENDGRID_FROM_EMAIL!,
    });
  },
});

createExpressServer(client);
