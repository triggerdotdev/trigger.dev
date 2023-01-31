import { z } from "zod";
import { issueSchema } from "./issues";
import {
  appSchema,
  authorAssociationSchema,
  installationLiteSchema,
  labelSchema,
  organizationSchema,
  reactionsSchema,
  repositorySchema,
  userSchema,
} from "./shared";

export const issueCommentSchema = z.object({
  url: z.string(),
  html_url: z.string(),
  issue_url: z.string(),
  id: z.number(),
  node_id: z.string(),
  user: userSchema,
  created_at: z.string(),
  updated_at: z.string(),
  author_association: authorAssociationSchema,
  body: z.string(),
  reactions: reactionsSchema,
  performed_via_github_app: appSchema.nullable(),
});

export const issueCommentCreatedEventSchema = z.object({
  action: z.literal("created"),
  issue: issueSchema.and(
    z.object({
      assignee: userSchema.nullable(),
      state: z.union([z.literal("open"), z.literal("closed")]),
      locked: z.boolean(),
      labels: z.array(labelSchema),
    })
  ),
  comment: issueCommentSchema,
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issueCommentDeletedEventSchema = z.object({
  action: z.literal("deleted"),
  issue: issueSchema.and(
    z.object({
      assignee: userSchema.nullable(),
      state: z.union([z.literal("open"), z.literal("closed")]),
      locked: z.boolean(),
      labels: z.array(labelSchema),
    })
  ),
  comment: issueCommentSchema,
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issueCommentEditedEventSchema = z.object({
  action: z.literal("edited"),
  changes: z.object({
    body: z
      .object({
        from: z.string(),
      })
      .optional(),
  }),
  issue: issueSchema.and(
    z.object({
      assignee: userSchema.nullable(),
      state: z.union([z.literal("open"), z.literal("closed")]),
      locked: z.boolean(),
      labels: z.array(labelSchema),
    })
  ),
  comment: issueCommentSchema,
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issueCommentEventSchema = z.discriminatedUnion("action", [
  issueCommentCreatedEventSchema,
  issueCommentDeletedEventSchema,
  issueCommentEditedEventSchema,
]);
