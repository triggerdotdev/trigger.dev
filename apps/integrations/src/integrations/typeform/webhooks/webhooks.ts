import { makeWebhook } from "core/webhook";
import { WebhookEvent, WebhookReceiveRequest } from "core/webhook/types";
import { authentication } from "../authentication";
import { example } from "./examples";
import { formEventSchema } from "./schemas";
import { formResponse } from "./specs";
import crypto from "node:crypto";
import { makeObjectSchema, makeStringSchema } from "core/schemas/makeSchema";

const baseUrl = "https://api.typeform.com";

export const formResponseEvent: WebhookEvent = {
  name: "form_response",
  metadata: {
    title: "Form response",
    description: "A form response was submitted",
    tags: ["form"],
  },
  schema: formEventSchema,
  instructions: (data) =>
    `Fill in your Typeform (${data.form_id}) as a real user would`,
  examples: [example],
  key: "${params.form_id}",
  displayProperties: (data) => ({
    title: `New response for form ${data.form_id}`,
    properties: [
      {
        key: "Form ID",
        value: data.form_id,
      },
    ],
  }),
  matches: () => true,
  process: async (data: WebhookReceiveRequest) => [
    {
      event: "form_response",
      displayProperties: {
        title: "New response",
      },
      payload: data.request.body,
    },
  ],
};

const webhook = makeWebhook({
  data: {
    baseUrl,
    spec: formResponse,
    authentication,
  },
  events: [formResponseEvent],
  subscription: {
    type: "automatic",
    requiresSecret: true,
    inputSchema: makeObjectSchema("Input", {
      requiredProperties: {
        form_id: makeStringSchema("Form ID"),
      },
    }),
    preSubscribe: (input) => {
      return {
        parameters: {
          form_id: input.data.form_id,
          tag: input.webhookId,
        },
        body: {
          enabled: true,
          secret: input.secret,
          url: input.callbackUrl,
          verify_ssl: true,
        },
      };
    },
  },
  preProcess: async (data) => {
    if (data.secret) {
      const signatureHeader = data.request.headers["typeform-signature"];
      const hash = crypto
        .createHmac("sha256", data.secret)
        .update(data.request.rawBody)
        .digest("base64");

      if (signatureHeader !== `sha256=${hash}`) {
        return {
          success: false,
          processEvents: false,
          error: "Invalid signature",
          response: {
            status: 401,
            headers: {},
          },
        };
      }
    }

    return {
      success: true,
      processEvents: true,
      response: {
        status: 200,
        headers: {},
      },
    };
  },
});

export const webhooks = { formResponse: webhook };
export const events = { formResponse: formResponseEvent };
