import { makeWebhook } from "core/webhook";
import { WebhookEvent, WebhookReceiveRequest } from "core/webhook/types";
import { authentication } from "../authentication";
import { example } from "./examples";
import { formEventSchema } from "./schemas";
import { formResponse } from "./specs";
import crypto from "node:crypto";

const baseUrl = "https://api.typeform.com";

export const formResponseEvent: WebhookEvent = {
  name: "form_response",
  metadata: {
    description: "A form response was submitted",
    displayProperties: {
      title: "New response",
    },
    tags: ["form"],
  },
  schema: formEventSchema,
  examples: [example],
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
