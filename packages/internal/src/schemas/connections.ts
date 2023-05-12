import { z } from "zod";

export const ConnectionMetadataSchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string(),
});

export type ConnectionMetadata = z.infer<typeof ConnectionMetadataSchema>;

export const ConnectionAuthSchema = z.object({
  type: z.enum(["oauth2"]),
  accessToken: z.string(),
  scopes: z.array(z.string()).optional(),
  additionalFields: z.record(z.string()).optional(),
});

export type ConnectionAuth = z.infer<typeof ConnectionAuthSchema>;

export const ConnectionConfigSchema = z.object({
  id: z.string(),
  metadata: ConnectionMetadataSchema,
});

export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;
