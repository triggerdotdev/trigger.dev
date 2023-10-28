import { z } from "zod";

export const WebhookEventTypeSchema = z.enum([
  "deployment.created",
  "deployment.succeeded",
  "deployment.ready",
  "deployment.canceled",
  "deployment.error",
]);

export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;
