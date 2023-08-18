import type { Integration } from "../types";

export const sendgrid: Integration = {
  identifier: "sendgrid",
  name: "SendGrid",
  packageName: "@trigger.dev/sendgrid@latest",
  authenticationMethods: {
    apikey: {
      type: "apikey",
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { SendGrid } from "@trigger.dev/sendgrid";

const sendgrid = new SendGrid({
  id: "__SLUG__",
  apiKey: process.env.SENDGRID_API_KEY!,
});
`,
          },
          {
            title: "Using the client",
            code: `
client.defineJob({
  id: "send-sendgrid-email",
  name: "Send SendGrid Email",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "send.email",
    schema: z.object({
      to: z.string(),
      subject: z.string(),
      text: z.string(),
    }),
  }),
  integrations: {
    sendgrid,
  },
  run: async (payload, io, ctx) => {
    await io.sendgrid.sendEmail({
      to: payload.to,
      from: "Trigger.dev <hello@email.trigger.dev>",
      subject: payload.subject,
      text: payload.text,
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
