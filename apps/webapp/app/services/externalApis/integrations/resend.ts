import type { Integration } from "../types";

export const resend: Integration = {
  identifier: "resend",
  name: "Resend",
  packageName: "@trigger.dev/resend",
  authenticationMethods: {
    apikey: {
      type: "apikey",
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { Resend } from "@trigger.dev/resend";

const resend = new Resend({
  id: "resend",
  apiKey: process.env.RESEND_API_KEY!,
});
`,
          },
          {
            title: "Using the client",
            code: `
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
    await io.resend.sendEmail("send-email", {
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      from: "Trigger.dev <hello@email.trigger.dev>",
    });
  },
});
            
            `,
            highlight: [
              [13, 15],
              [17, 22],
            ],
          },
        ],
      },
    },
  },
};
