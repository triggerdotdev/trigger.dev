import { z } from "zod";
import {
  repositorySchema,
  installationLiteSchema,
  organizationSchema,
  userSchema,
  authorAssociationSchema,
  linkSchema,
  simplePullRequestSchema,
} from "./shared";

export const pullRequestReviewSchema = z.object({
  id: z.number(),
  node_id: z.string(),
  user: userSchema,
  body: z.string().nullable(),
  commit_id: z.string(),
  submitted_at: z.string().nullable(),
  state: z.union([
    z.literal("commented"),
    z.literal("changes_requested"),
    z.literal("approved"),
    z.literal("dismissed"),
  ]),
  html_url: z.string(),
  pull_request_url: z.string(),
  author_association: authorAssociationSchema,
  _links: z.object({
    html: linkSchema,
    pull_request: linkSchema,
  }),
});

export const pullRequestReviewDismissedEventSchema = z.object({
  action: z.literal("dismissed"),
  review: pullRequestReviewSchema.and(
    z.object({
      state: z.literal("dismissed"),
    })
  ),
  pull_request: simplePullRequestSchema,
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestReviewEditedEventSchema = z.object({
  action: z.literal("edited"),
  changes: z.object({
    body: z
      .object({
        from: z.string(),
      })
      .optional(),
  }),
  review: pullRequestReviewSchema,
  pull_request: simplePullRequestSchema,
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestReviewSubmittedEventSchema = z.object({
  action: z.literal("submitted"),
  review: pullRequestReviewSchema,
  pull_request: simplePullRequestSchema,
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestReviewEventSchema = z.discriminatedUnion("action", [
  pullRequestReviewDismissedEventSchema,
  pullRequestReviewEditedEventSchema,
  pullRequestReviewSubmittedEventSchema,
]);
