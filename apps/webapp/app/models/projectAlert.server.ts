import { z } from "zod";
import { EncryptedSecretValueSchema } from "~/services/secrets/secretStore.server";

export const ProjectAlertWebhookProperties = z.object({
  secret: EncryptedSecretValueSchema,
  url: z.string(),
});

export type ProjectAlertWebhookProperties = z.infer<typeof ProjectAlertWebhookProperties>;

export const ProjectAlertEmailProperties = z.object({
  email: z.string(),
});

export type ProjectAlertEmailProperties = z.infer<typeof ProjectAlertEmailProperties>;

export const DeleteProjectAlertChannel = z.object({
  id: z.string(),
});
