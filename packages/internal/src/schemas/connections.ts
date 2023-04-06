import { z } from "zod";

export const ConnectionMetadataSchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string(),
});

export type ConnectionMetadata = z.infer<typeof ConnectionMetadataSchema>;

export const ApiKeyConnectionAuthSchema = z.object({
  type: z.literal("apiKey"),
  apiKey: z.string(),
  additionalFields: z.record(z.string()).optional(),
});

export type ApiKeyConnectionAuth = z.infer<typeof ApiKeyConnectionAuthSchema>;

export const OAuthConnectionAuthSchema = z.object({
  type: z.literal("oauth"),
  accessToken: z.string(),
  additionalFields: z.record(z.string()).optional(),
});

export type OAuthConnectionAuth = z.infer<typeof OAuthConnectionAuthSchema>;

export const BasicAuthConnectionAuthSchema = z.object({
  type: z.literal("basicAuth"),
  username: z.string(),
  password: z.string(),
  additionalFields: z.record(z.string()).optional(),
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
