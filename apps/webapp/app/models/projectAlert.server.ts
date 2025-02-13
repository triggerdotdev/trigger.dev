import { z } from "zod";
import { EncryptedSecretValueSchema } from "~/services/secrets/secretStore.server";

export const ProjectAlertWebhookProperties = z.object({
  secret: EncryptedSecretValueSchema,
  url: z.string(),
  version: z.string().optional().default("v1"),
});

export type ProjectAlertWebhookProperties = z.infer<typeof ProjectAlertWebhookProperties>;

export const ProjectAlertEmailProperties = z.object({
  email: z.string(),
});

export type ProjectAlertEmailProperties = z.infer<typeof ProjectAlertEmailProperties>;

export const DeleteProjectAlertChannel = z.object({
  id: z.string(),
});

export const ProjectAlertSlackProperties = z.object({
  channelId: z.string(),
  channelName: z.string(),
  integrationId: z.string().nullish(),
});

export type ProjectAlertSlackProperties = z.infer<typeof ProjectAlertSlackProperties>;

export const ProjectAlertSlackStorage = z.object({
  message_ts: z.string(),
});

export type ProjectAlertSlackStorage = z.infer<typeof ProjectAlertSlackStorage>;
