import { TriggerEvent } from "@trigger.dev/sdk";
import { airtable } from "@trigger.dev/providers";

export function all(params: {
  baseId: string;
}): TriggerEvent<typeof airtable.schemas.allEventSchema> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: "airtable",
      name: "all",
      filter: {
        service: ["airtable"],
        payload: {
          base: {
            id: [params.baseId],
          },
        },
        event: ["all"],
      },
      source: airtable.schemas.WebhookSourceSchema.parse({
        baseId: params.baseId,
        scopes: [
          "data.records:read",
          "data.records:write",
          "data.recordComments:read",
          "data.recordComments:write",
          "schema.bases:read",
          "schema.bases:write",
          "webhook:manage",
        ],
        events: ["all"],
      }),
    },
    schema: airtable.schemas.allEventSchema,
  };
}
