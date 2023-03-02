import { createJSONPointer } from "core/common/pointer";
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
      schema: {
        type: "string",
      },
      in: "path",
    },
    {
      name: "tag",
      description: "The webhook tag",
      required: true,
      schema: {
        type: "string",
      },
      in: "path",
    },
    {
      name: "secret",
      description: "The webhook secret",
      required: true,
      schema: {
        type: "string",
      },
      in: "body",
      pointer: createJSONPointer(["secret"]),
    },
    {
      name: "callbackUrl",
      description: "The webhook url",
      required: true,
      schema: {
        type: "string",
      },
      in: "body",
      pointer: createJSONPointer(["url"]),
    },
  ],
  request: {
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      schema: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
          },
          secret: {
            type: "string",
          },
          url: {
            type: "string",
          },
          verify_ssl: {
            type: "boolean",
          },
        },
      },
      static: {
        "/enabled": true,
        "/verify_ssl": true,
      },
    },
  },
  responses: [
    {
      success: true,
      name: "Success",
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      schema: {
        type: "object",
        properties: {
          created_at: {
            type: "string",
          },
          enabled: {
            type: "boolean",
          },
          form_id: {
            type: "string",
          },
          id: {
            type: "string",
          },
          tag: {
            type: "string",
          },
          updated_at: {
            type: "string",
          },
          url: {
            type: "string",
          },
          verify_ssl: {
            type: "boolean",
          },
        },
      },
    },
    {
      success: false,
      name: "Error",
      matches: ({ statusCode }) => statusCode < 200 || statusCode >= 300,
      schema: {
        type: "object",
        additionalProperties: true,
      },
    },
  ],
};

export const formResponse: WebhookSpec = {
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
    create: createEndpoint,
  },
};
