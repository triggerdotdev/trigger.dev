import { z } from "zod";
import * as messageEvents from "./messageEvents";
import * as messages from "./messages";

export const WebhookSourceSchema = z.object({
  subresource: z.literal("messages"),
  accountId: z.string(),
  event: z.string(),
  verifyPayload: z.object({
    enabled: z.boolean(),
  }),
});

export type MessageEvent = z.infer<typeof messageEvents.messageEventSchema>;
export type MessageEventMessage = MessageEvent["message"];

export { messageEvents, messages };
