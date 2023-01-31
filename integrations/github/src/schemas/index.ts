import { z } from "zod";
import * as commitComments from "./commitComments";
import * as issuesComments from "./issueComments";
import * as issues from "./issues";
import * as pullRequestComments from "./pullRequestComments";
import * as pullRequestReviews from "./pullRequestReviews";
import * as pullRequest from "./pullRequests";
import * as push from "./pushes";
import * as stars from "./stars";

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

export {
  commitComments,
  issues,
  issuesComments,
  pullRequest,
  pullRequestComments,
  pullRequestReviews,
  push,
  stars,
};
