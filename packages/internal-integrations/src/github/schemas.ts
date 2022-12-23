import { z } from "zod";

export const WebhookRepoSourceSchema = z.object({
  subresource: z.literal("repository"),
  scopes: z.array(z.string()),
  repo: z.string(),
  events: z.array(z.string()),
});

export type WebhookRepoSource = z.infer<typeof WebhookRepoSourceSchema>;

export const WebhookOrganizationSourceSchema = z.object({
  subresource: z.literal("organization"),
  scopes: z.array(z.string()),
  org: z.string(),
  events: z.array(z.string()),
});

export type WebhookOrganizationSource = z.infer<
  typeof WebhookOrganizationSourceSchema
>;

export const WebhookSourceSchema = z.union([
  WebhookRepoSourceSchema,
  WebhookOrganizationSourceSchema,
]);

export const IssueEventSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("opened"),
    issue: z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      url: z.string(),
    }),
  }),
  z.object({
    action: z.literal("removed"),
    issue: z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      url: z.string(),
    }),
  }),
]);
