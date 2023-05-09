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

const CommonConnectionConfigSchema = z.object({
  metadata: ConnectionMetadataSchema,
});

const LocalAuthConnectionConfigSchema = CommonConnectionConfigSchema.extend({
  auth: z.literal("local"),
});

const HostedAuthConnectionConfigSchema = CommonConnectionConfigSchema.extend({
  auth: z.literal("hosted"),
  id: z.string(),
});

export const ConnectionConfigSchema = z.discriminatedUnion("auth", [
  LocalAuthConnectionConfigSchema,
  HostedAuthConnectionConfigSchema,
]);

export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;
export type LocalAuthConnectionConfig = z.infer<
  typeof LocalAuthConnectionConfigSchema
>;
export type HostedAuthConnectionConfig = z.infer<
  typeof HostedAuthConnectionConfigSchema
>;
