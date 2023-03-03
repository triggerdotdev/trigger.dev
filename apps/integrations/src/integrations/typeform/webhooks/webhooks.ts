import { makeWebhook } from "core/webhook";
import { WebhookEvent, WebhookReceiveRequest } from "core/webhook/types";
import { authentication } from "../authentication";
import { example } from "./examples";
import { formEventSchema } from "./schemas";
import { formResponse } from "./specs";

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
  postSubscribe: (result) => ({
    ...result,
    secret: "super-secret",
  }),
});

export const webhooks = { formResponse: webhook };
export const events = { formResponse: formResponseEvent };
