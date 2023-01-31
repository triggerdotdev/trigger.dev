import type { TriggerEvent } from "@trigger.dev/sdk";
import * as schemas from "./schemas";

export function messageEvent(params: {
  accountId: string;
}): TriggerEvent<typeof schemas.messageEvents.messageEventSchema> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: "whatsapp",
      name: "messages",
      filter: {
        service: ["whatsapp"],
        payload: {
          type: ["message"],
        },
        event: ["messages"],
      },
      source: schemas.WebhookSourceSchema.parse({
        subresource: "messages",
        accountId: params.accountId,
        verifyPayload: {
          enabled: true,
        },
        event: "messages",
      }),
      manualRegistration: true,
    },
    schema: schemas.messageEvents.messageEventSchema,
  };
}
