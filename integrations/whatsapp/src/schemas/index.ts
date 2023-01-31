import { z } from "zod";
import * as messageEvents from "./messageEvents";

export const WebhookSourceSchema = z.object({
  subresource: z.literal("messages"),
  accountId: z.string(),
  scopes: z.array(z.string()),
  events: z.array(z.string()),
});

export { messageEvents };
