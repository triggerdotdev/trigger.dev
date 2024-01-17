import { createExpressServer } from "@trigger.dev/express";
import { Resend } from "@trigger.dev/resend";
import { TriggerClient, eventTrigger, invokeTrigger } from "@trigger.dev/sdk";
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
  trigger: invokeTrigger({
    schema: z.object({
      to: z.union([z.string(), z.array(z.string())]).default("eric@trigger.dev"),
      subject: z.string().default("This is a test email"),
      text: z.string().default("This is a test email"),
    }),
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const response = await io.resend.emails.send("📧", {
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      from: "Trigger.dev <hello@email.trigger.dev>",
    });

    await io.logger.info("Sent email", { response });

    const emailDetails = await io.resend.emails.get("get-email", response.id);
  },
});

client.defineJob({
  id: "batch-send-resend-email",
  name: "Batch Send Resend Email",
  version: "0.1.0",
  trigger: invokeTrigger({
    schema: z.object({
      to: z.union([z.string(), z.array(z.string())]).default("eric@trigger.dev"),
      subject: z.string().default("This is a test email"),
      text: z.string().default("This is a test email"),
    }),
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const response = await io.resend.batch.send("📧", [
      {
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        from: "Trigger.dev <hello@email.trigger.dev>",
      },
      {
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        from: "Trigger.dev <hello@email.trigger.dev>",
      },
    ]);

    await io.logger.info("Sent batched email", { response });
  },
});

client.defineJob({
  id: "send-resend-email-deprecated",
  name: "Send Resend Email Deprecated",
  version: "0.1.0",
  trigger: invokeTrigger({
    schema: z.object({
      to: z.union([z.string(), z.array(z.string())]).default("eric@trigger.dev"),
      subject: z.string().default("This is a test email"),
      text: z.string().default("This is a test email"),
    }),
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const response = await io.resend.sendEmail("📧", {
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      from: "Trigger.dev <hello@email.trigger.dev>",
    });

    await io.logger.info("Sent email", { response });
  },
});

client.defineJob({
  id: "send-resend-email-from-blank",
  name: "Send Resend Email From Blank",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "send.email",
    schema: z.object({
      to: z.union([z.string(), z.array(z.string())]),
      subject: z.string(),
      text: z.string(),
      from: z.string().optional(),
    }),
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const response = await io.resend.sendEmail("📧", {
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      from: payload.from!,
    });

    await io.logger.info("Sent email", { response });
  },
});

client.defineJob({
  id: "create-resend-audience",
  name: "Create Resend Audience",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "create.audience",
    schema: z.object({
      name: z.string(),
    }),
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const response = await io.resend.audiences.create("📧", {
      name: payload.name,
    });

    await io.logger.info("Created audience", { response });
  },
});

client.defineJob({
  id: "get-resend-audience",
  name: "Get Resend Audience",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "get.audience",
    schema: z.object({
      id: z.string(),
    }),
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const response = await io.resend.audiences.get("📧", payload.id);

    await io.logger.info("Got audience", { response });
  },
});

client.defineJob({
  id: "remove-resend-audience",
  name: "Remove Resend Audience",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "remove.audience",
    schema: z.object({
      id: z.string(),
    }),
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const response = await io.resend.audiences.remove("📧", payload.id);

    await io.logger.info("Removed audience", { response });
  },
});

client.defineJob({
  id: "list-resend-audiences",
  name: "List Resend Audiences",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "list.audiences",
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const response = await io.resend.audiences.list("📧");

    await io.logger.info("Listed audiences", { response });
  },
});

client.defineJob({
  id: "create resend contact",
  name: "Create Resend Contact",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "create.contact",
    schema: z.object({
      audience_id: z.string(),
      email: z.string(),
      unsubscribed: z.boolean().optional(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
    }),
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const response = await io.resend.contacts.create("📧", {
      audience_id: payload.audience_id,
      email: payload.email,
      unsubscribed: payload.unsubscribed,
      first_name: payload.first_name,
      last_name: payload.last_name,
    });

    await io.logger.info("Created contact", { response });
  },
});

client.defineJob({
  id: "get resend contact",
  name: "Get Resend Contact",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "get.contact",
    schema: z.object({
      audience_id: z.string(),
      id: z.string(),
    }),
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const response = await io.resend.contacts.get("📧", {
      audience_id: payload.audience_id,
      id: payload.id,
    });

    await io.logger.info("Got contact", { response });
  },
});

client.defineJob({
  id: "update resend contact",
  name: "Update Resend Contact",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "update.contact",
    schema: z.object({
      audience_id: z.string(),
      id: z.string(),
      email: z.string().optional(),
      unsubscribed: z.boolean().optional(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
    }),
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const response = await io.resend.contacts.update("📧", {
      audience_id: payload.audience_id,
      id: payload.id,
      unsubscribed: payload.unsubscribed,
      first_name: payload.first_name,
      last_name: payload.last_name,
    });

    await io.logger.info("Updated contact", { response });
  },
});

client.defineJob({
  id: "remove resend contact",
  name: "Remove Resend Contact",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "remove.contact",
    schema: z.object({
      audience_id: z.string(),
      id: z.string(),
    }),
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const response = await io.resend.contacts.remove("📧", {
      audience_id: payload.audience_id,
      id: payload.id,
    });

    await io.logger.info("Removed contact", { response });
  },
});

client.defineJob({
  id: "list resend contacts",
  name: "List Resend Contacts",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "list.contacts",
    schema: z.object({
      audience_id: z.string(),
    }),
  }),
  integrations: {
    resend,
  },
  run: async (payload, io, ctx) => {
    const response = await io.resend.contacts.list("📧", {
      audience_id: payload.audience_id,
    });

    await io.logger.info("Listed contacts", { response });
  },
});

createExpressServer(client);
