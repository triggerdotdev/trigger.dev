import { z } from "zod";
import * as messageEvents from "./messageEvents";

export const WebhookSourceSchema = z.object({
  subresource: z.literal("messages"),
  accountId: z.string(),
  event: z.string(),
  verifyPayload: z.object({
    enabled: z.boolean(),
  }),
});

export { messageEvents };
