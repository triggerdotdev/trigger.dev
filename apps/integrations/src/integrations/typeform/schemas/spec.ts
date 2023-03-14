import { makeObjectSchema, makeStringSchema } from "core/schemas/makeSchema";
import { IntegrationSchema } from "core/schemas/types";
import { formEventSchema } from "../webhooks/schemas";

export const spec: IntegrationSchema = {
  definitions: {
    form_id: {
      type: "string",
    },
    tag: {
      type: "string",
    },
    create_endpoint_request_body: {
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
    create_endpoint_response_body_success: {
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
    error_response_body: {
      type: "object",
      additionalProperties: true,
    },
    webhook_subscription_input: makeObjectSchema("Input", {
      requiredProperties: {
        form_id: makeStringSchema("Form ID"),
      },
    }),
    form_event: formEventSchema,
  },
};
