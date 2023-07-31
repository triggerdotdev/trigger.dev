import { z } from "zod";

export const ConnectionAuthSchema = z.object({
  type: z.enum(["oauth2"]),
  accessToken: z.string(),
  scopes: z.array(z.string()).optional(),
  additionalFields: z.record(z.string()).optional(),
});

export type ConnectionAuth = z.infer<typeof ConnectionAuthSchema>;

export const IntegrationMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string().optional(),
});

export type IntegrationMetadata = z.infer<typeof IntegrationMetadataSchema>;

export const IntegrationConfigSchema = z.object({
  id: z.string(),
  metadata: IntegrationMetadataSchema,
  authSource: z.enum(["HOSTED", "LOCAL"]),
});

export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;
