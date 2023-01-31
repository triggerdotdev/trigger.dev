import type { TriggerEvent } from "@trigger.dev/sdk";
import * as schemas from "./schemas";

export function messageEvent(params: {
  repo: string;
}): TriggerEvent<typeof schemas.messageEvents.messageEventSchema> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: "whatsapp",
      name: "message",
      filter: {
        service: ["whatsapp"],
        payload: {},
        event: ["message"],
      },
      source: {
        verifyPayload: {
          enabled: true,
        },
        event: "message",
      },
      manualRegistration: true,
    },
    schema: schemas.messageEvents.messageEventSchema,
  };
}
