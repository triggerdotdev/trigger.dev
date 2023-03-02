import { makeWebhook } from "core/webhook";
import { WebhookEvent, WebhookReceiveRequest } from "core/webhook/types";
import { authentication } from "../authentication";
import { formResponse } from "./specs";

const baseUrl = "https://api.typeform.com";

const formResponseEvent: WebhookEvent = {
  name: "form_response",
  metadata: {
    description: "A form response was submitted",
    displayProperties: {
      title: "New response",
    },
    tags: ["form"],
  },
  schema: {},
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
  events: [],
  postSubscribe: (result) => ({
    ...result,
    secret: "super-secret",
  }),
});

export default {
  formResponse: webhook,
};
