import { z } from "zod";
import * as issues from "./issues";

export const WebhookRepoSourceSchema = z.object({
  subresource: z.literal("repository"),
  scopes: z.array(z.string()),
  repo: z.string(),
  events: z.array(z.string()),
});

export const WebhookOrganizationSourceSchema = z.object({
  subresource: z.literal("organization"),
  scopes: z.array(z.string()),
  org: z.string(),
  events: z.array(z.string()),
});

export const WebhookSourceSchema = z.union([
  WebhookRepoSourceSchema,
  WebhookOrganizationSourceSchema,
]);

export { issues };
