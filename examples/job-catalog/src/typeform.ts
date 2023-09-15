import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { Typeform } from "@trigger.dev/typeform";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

export const typeform = new Typeform({
  id: "typeform-1",
  token: process.env["TYPEFORM_API_KEY"]!,
});

client.defineJob({
  id: "typeform-playground",
  name: "Typeform Playground",
  version: "0.1.1",
  integrations: {
    typeform,
  },
  trigger: eventTrigger({
    name: "typeform.playground",
    schema: z.object({
      formId: z.string().optional(),
    }),
  }),
  run: async (payload, io, ctx) => {
    await io.typeform.listForms("list-forms");

    if (payload.formId) {
      const form = await io.typeform.getForm("get-form", {
        uid: payload.formId,
      });

      const listResponses = await io.typeform.listResponses("list-responses", {
        uid: payload.formId,
        pageSize: 50,
      });

      const allResponses = await io.typeform.getAllResponses("get-all-responses", {
        uid: payload.formId,
      });
    }
  },
});

client.defineJob({
  id: "typeform-webhook-2",
  name: "Typeform Webhook 2",
  version: "0.1.1",
  trigger: typeform.onFormResponse({
    uid: "KywLXMeB",
    tag: "tag1",
  }),
  run: async (payload, io, ctx) => {},
});

createExpressServer(client);
