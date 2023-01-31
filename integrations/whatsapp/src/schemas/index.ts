import { z } from "zod";
import * as messageEvents from "./messageEvents";

export const WebhookSourceSchema = z.object({
  scopes: z.array(z.string()),
  events: z.array(z.string()),
});

export { messageEvents };
