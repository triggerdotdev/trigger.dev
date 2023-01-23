import { z } from "zod";

export const WebhookSourceSchema = z.object({
  baseId: z.string(),
  scopes: z.array(z.string()),
  events: z.array(z.string()),
});

export const allEvent = z.any();
