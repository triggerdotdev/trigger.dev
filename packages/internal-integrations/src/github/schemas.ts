import { z } from "zod";

export const WebhookSchema = z.object({
  events: z.array(z.string()),
  params: z.object({
    repo: z.string(),
  }),
  scopes: z.array(z.string()).optional(),
});

export const IssueEventSchema = z.object({
  action: z.literal("opened"),
  issue: z.object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    url: z.string(),
  }),
});
