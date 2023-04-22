import { z } from "zod";

export const ConnectionMetadataSchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string(),
});

export type ConnectionMetadata = z.infer<typeof ConnectionMetadataSchema>;

const BaseConnectionAuthSchema = z.object({
  additionalFields: z.record(z.string()).optional(),
  connectionId: z.string().optional(),
});

export const ApiKeyConnectionAuthSchema = BaseConnectionAuthSchema.extend({
  type: z.literal("apiKey"),
  apiKey: z.string(),
});

export type ApiKeyConnectionAuth = z.infer<typeof ApiKeyConnectionAuthSchema>;

export const OAuthConnectionAuthSchema = BaseConnectionAuthSchema.extend({
  type: z.literal("oauth"),
  accessToken: z.string(),
});

export type OAuthConnectionAuth = z.infer<typeof OAuthConnectionAuthSchema>;

export const BasicAuthConnectionAuthSchema = BaseConnectionAuthSchema.extend({
  type: z.literal("basicAuth"),
  username: z.string(),
  password: z.string(),
});

export type BasicAuthConnectionAuth = z.infer<
  typeof BasicAuthConnectionAuthSchema
>;

export const ConnectionAuthSchema = z.discriminatedUnion("type", [
  ApiKeyConnectionAuthSchema,
  OAuthConnectionAuthSchema,
  BasicAuthConnectionAuthSchema,
]);

export type ConnectionAuth = z.infer<typeof ConnectionAuthSchema>;
