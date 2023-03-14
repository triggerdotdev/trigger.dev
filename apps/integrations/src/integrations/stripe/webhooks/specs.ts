import { EndpointSpec } from "core/endpoint/types";
import { WebhookSpec } from "core/webhook/types";

const createEndpoint: EndpointSpec = {
  method: "POST",
  path: "/webhook_endpoints",
  metadata: {
    name: "Create webhook",
    description: "Create a webhook for a form",
    displayProperties: {
      title: "Create webhook",
    },
    tags: ["webhook"],
  },
  security: {
    apiKey: ["webhooks:write"],
  },
  request: {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: {
      format: {
        type: "form-urlencoded",
        encoding: {
          enabled_events: {
            style: "deepObject",
            explode: true,
          },
          expand: {
            style: "deepObject",
            explode: true,
          },
          metadata: {
            style: "deepObject",
            explode: true,
          },
        },
      },
      schema: "#/definitions/create_webhook_endpoint_request_body",
    },
  },
  responses: [
    {
      success: true,
      name: "Success",
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      schema: "#/definitions/create_webhook_endpoint_response_body_success",
    },
    {
      success: false,
      name: "Error",
      matches: ({ statusCode }) => statusCode < 200 || statusCode >= 300,
      schema: "#/definitions/error_response_body",
    },
  ],
};

export const webhookSpec: WebhookSpec = {
  id: "webhook",
  metadata: {
    name: "Stripe webhooks",
    description: "An event happened in your Stripe account",
    tags: ["stripe"],
  },
  subscribe: {
    type: "automatic",
    requiresSecret: true,
    create: createEndpoint,
  },
};
