import { Webhook } from "core/webhook/types";

export const webhook: Webhook = {
  id: "form_response",
  metadata: {
    name: "Form response",
    description: "A response to your Typeform",
    displayProperties: {
      title: "New response to your typeform",
    },
    tags: ["form"],
  },
  events: ["form_response"],
  subscribe: {
    type: "automatic",
    create: async ({ credentials, callbackUrl, events, secret, params }) => {
      return {
        method: "POST",
        url: `https://api.typeform.com/forms/${params.form_id}/webhooks/${params.tag}`,
        headers: {
          "Content-Type": "application/json",
          //todo credentials
          Authorization: `Bearer ${credentials}`,
        },
        body: {
          enabled: true,
          secret,
          url: callbackUrl,
          verify_ssl: true,
        },
      };
    },
  },
};
