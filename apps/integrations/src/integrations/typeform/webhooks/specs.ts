import { EndpointSpec } from "core/endpoint/types";
import { WebhookSpec } from "core/webhook/types";

const createEndpoint: EndpointSpec = {
  method: "PUT",
  path: "/forms/{form_id}/webhooks/{tag}",
  metadata: {
    name: "Create webhook",
    description: "Create a webhook for a form",
    displayProperties: {
      title: "Create webhook",
    },
    tags: ["form"],
  },
  security: {
    accessToken: ["webhooks:write"],
  },
  parameters: [
    {
      name: "form_id",
      description: "The form ID",
      required: true,
      schema: "#/definitions/form_id",
      in: "path",
    },
    {
      name: "tag",
      description: "The webhook tag",
      required: true,
      schema: "#/definitions/tag",
      in: "path",
    },
  ],
  request: {
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      schema: "#/definitions/create_endpoint_request_body",
    },
  },
  responses: [
    {
      success: true,
      name: "Success",
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      schema: "#/definitions/create_endpoint_response_body_success",
    },
    {
      success: false,
      name: "Error",
      matches: ({ statusCode }) => statusCode < 200 || statusCode >= 300,
      schema: "#/definitions/error_response_body",
    },
  ],
};

export const formResponse: WebhookSpec = {
  id: "form_response",
  metadata: {
    name: "Form response",
    description: "A response to your Typeform",
    tags: ["form"],
  },
  subscribe: {
    type: "automatic",
    requiresSecret: true,
    create: createEndpoint,
  },
};
