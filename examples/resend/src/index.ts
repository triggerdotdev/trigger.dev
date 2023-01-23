import { Trigger, customEvent } from "@trigger.dev/sdk";
import { resend } from "@trigger.dev/integrations";
import { z } from "zod";

new Trigger({
  id: "resend",
  name: "Resend text/html",
  apiKey: "trigger_development_YpG7UQygbuT3",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "send.email",
    schema: z.object({
      from: z.string(),
      to: z.union([z.string(), z.array(z.string())]),
      bcc: z.union([z.string(), z.array(z.string())]).optional(),
      cc: z.union([z.string(), z.array(z.string())]).optional(),
      replyTo: z.union([z.string(), z.array(z.string())]).optional(),
      subject: z.string().optional(),
      text: z.string().optional(),
      html: z.string().optional(),
    }),
  }),
  run: async (event, ctx) => {
    const response = await resend.sendEmail("text-email", {
      to: event.to,
      from: event.from,
      cc: event.cc,
      bcc: event.bcc,
      replyTo: event.replyTo,
      subject: event.subject,
      text: event.text,
      html: event.html,
    });

    return response;
  },
}).listen();
