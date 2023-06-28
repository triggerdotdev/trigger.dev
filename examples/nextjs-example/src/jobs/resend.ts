import { client } from "@/trigger";
import { Resend } from "@trigger.dev/resend";
import { Job, eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

const resend = new Resend({
  id: "resend-client",
  apiKey: process.env.RESEND_API_KEY!,
});

new Job(client, {
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
