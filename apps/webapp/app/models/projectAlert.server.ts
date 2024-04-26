import { z } from "zod";

export const ProjectAlertWebhookProperties = z.object({
  secret: z.string(),
  url: z.string(),
});

export type ProjectAlertWebhookProperties = z.infer<typeof ProjectAlertWebhookProperties>;

export const ProjectAlertEmailProperties = z.object({
  email: z.string(),
});

export type ProjectAlertEmailProperties = z.infer<typeof ProjectAlertEmailProperties>;
