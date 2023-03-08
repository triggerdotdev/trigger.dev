import { schemaFromRef } from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";
import { spec } from "../schemas/spec";

export const checkoutSessionCompletedSchema: JSONSchema =
  wrapEventWithWebhookData(
    "Checkout session completed",
    schemaFromRef("#/components/schemas/checkout.session", spec)
  );

function wrapEventWithWebhookData(
  name: string,
  eventSchema: JSONSchema
): JSONSchema {
  const { components, ...schema } = eventSchema;
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: name,
    type: "object",
    properties: {
      id: {
        type: "string",
      },
      data: {
        type: "object",
        properties: {
          object: {
            ...schema,
          },
        },
        required: ["object"],
      },
      type: {
        type: "string",
      },
      object: {
        type: "string",
        const: "event",
      },
      created: {
        type: "number",
      },
      request: {
        type: "object",
        properties: {
          id: {
            type: ["string", "null"],
          },
          idempotency_key: {
            type: ["string", "null"],
          },
        },
        required: ["id", "idempotency_key"],
      },
      livemode: {
        type: "boolean",
      },
      api_version: {
        type: "string",
      },
      pending_webhooks: {
        type: "number",
      },
    },
    required: [
      "id",
      "data",
      "type",
      "object",
      "created",
      "request",
      "livemode",
      "api_version",
      "pending_webhooks",
    ],
    components,
  };
}
