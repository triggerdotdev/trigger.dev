import { z } from "zod";
import {
  authorAssociationSchema,
  installationLiteSchema,
  labelSchema,
  linkSchema,
  milestoneSchema,
  organizationSchema,
  pullRequestAutoMergeSchema,
  repositorySchema,
  teamSchema,
  userSchema,
} from "./shared";

export const pullRequestSchema = z.object({
  url: z.string(),
  id: z.number(),
  node_id: z.string(),
  html_url: z.string(),
  diff_url: z.string(),
  patch_url: z.string(),
  issue_url: z.string(),
  number: z.number(),
  state: z.union([z.literal("open"), z.literal("closed")]),
  locked: z.boolean(),
  title: z.string(),
  user: userSchema,
  body: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullish(),
  merged_at: z.string().nullish(),
  merge_commit_sha: z.string().nullish(),
  assignee: userSchema.nullish(),
  assignees: z.array(userSchema),
  requested_reviewers: z.array(z.union([userSchema, teamSchema])),
  requested_teams: z.array(teamSchema),
  labels: z.array(labelSchema),
  milestone: milestoneSchema.nullish(),
  commits_url: z.string(),
  review_comments_url: z.string(),
  review_comment_url: z.string(),
  comments_url: z.string(),
  statuses_url: z.string(),
  head: z.object({
    label: z.string(),
    ref: z.string(),
    sha: z.string(),
    user: userSchema,
    repo: repositorySchema,
  }),
  base: z.object({
    label: z.string(),
    ref: z.string(),
    sha: z.string(),
    user: userSchema,
    repo: repositorySchema,
  }),
  _links: z.object({
    self: linkSchema,
    html: linkSchema,
    issue: linkSchema,
    comments: linkSchema,
    review_comments: linkSchema,
    review_comment: linkSchema,
    commits: linkSchema,
    statuses: linkSchema,
  }),
  author_association: authorAssociationSchema,
  auto_merge: pullRequestAutoMergeSchema.nullish(),
  active_lock_reason: z
    .union([
      z.literal("resolved"),
      z.literal("off-topic"),
      z.literal("too heated"),
      z.literal("spam"),
    ])
    .nullish(),
  draft: z.boolean().nullish(),
  merged: z.boolean().nullish(),
  mergeable: z.boolean().nullish(),
  rebaseable: z.boolean().nullish(),
  mergeable_state: z.string(),
  merged_by: userSchema.nullish(),
  comments: z.number(),
  review_comments: z.number(),
  maintainer_can_modify: z.boolean(),
  commits: z.number(),
  additions: z.number(),
  deletions: z.number(),
  changed_files: z.number(),
});

export const pullRequestAssignedEventSchema = z.object({
  action: z.literal("assigned"),
  number: z.number(),
  pull_request: pullRequestSchema,
  assignee: userSchema,
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestAutoMergeDisabledEventSchema = z.object({
  action: z.literal("auto_merge_disabled"),
  number: z.number(),
  pull_request: pullRequestSchema,
  reason: z.string(),
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestAutoMergeEnabledEventSchema = z.object({
  action: z.literal("auto_merge_enabled"),
  number: z.number(),
  pull_request: pullRequestSchema,
  reason: z.string(),
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestClosedEventSchema = z.object({
  action: z.literal("closed"),
  number: z.number(),
  pull_request: pullRequestSchema.and(
    z.object({
      state: z.literal("closed"),
      closed_at: z.string(),
      merged: z.boolean(),
    })
  ),
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestConvertedToDraftEventSchema = z.object({
  action: z.literal("converted_to_draft"),
  number: z.number(),
  pull_request: pullRequestSchema.and(
    z.object({
      closed_at: z.null(),
      merged_at: z.null(),
      draft: z.literal(true),
      merged: z.literal(false),
      merged_by: z.null(),
    })
  ),
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestDequeuedEventSchema = z.object({
  action: z.literal("dequeued"),
  number: z.number(),
  reason: z.string(),
  pull_request: pullRequestSchema,
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestEditedEventSchema = z.object({
  action: z.literal("edited"),
  number: z.number(),
  changes: z.object({
    body: z
      .object({
        from: z.string(),
      })
      .optional(),
    title: z
      .object({
        from: z.string(),
      })
      .optional(),
    base: z
      .object({
        ref: z.object({
          from: z.string(),
        }),
        sha: z.object({
          from: z.string(),
        }),
      })
      .optional(),
  }),
  pull_request: pullRequestSchema,
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestLabeledEventSchema = z.object({
  action: z.literal("labeled"),
  number: z.number(),
  pull_request: pullRequestSchema,
  label: labelSchema,
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestLockedEventSchema = z.object({
  action: z.literal("locked"),
  number: z.number(),
  pull_request: pullRequestSchema,
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestOpenedEventSchema = z.object({
  action: z.literal("opened"),
  number: z.number(),
  pull_request: pullRequestSchema.and(
    z.object({
      state: z.literal("open"),
      closed_at: z.null().optional(),
      merged_at: z.null().optional(),
      active_lock_reason: z.null().optional(),
      merged_by: z.null().optional(),
    })
  ),
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestQueuedEventSchema = z.object({
  action: z.literal("queued"),
  number: z.number(),
  pull_request: pullRequestSchema,
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestReadyForReviewEventSchema = z.object({
  action: z.literal("ready_for_review"),
  number: z.number(),
  pull_request: pullRequestSchema.and(
    z.object({
      state: z.literal("open"),
      closed_at: z.null(),
      merged_at: z.null(),
      draft: z.literal(false),
      merged: z.boolean(),
      merged_by: z.null(),
    })
  ),
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestReopenedEventSchema = z.object({
  action: z.literal("reopened"),
  number: z.number(),
  pull_request: pullRequestSchema.and(
    z.object({
      state: z.literal("open"),
      closed_at: z.null(),
      merged_at: z.null(),
      merged: z.boolean(),
      merged_by: z.null(),
    })
  ),
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestSynchronizeEventSchema = z.object({
  action: z.literal("synchronize"),
  number: z.number(),
  before: z.string(),
  after: z.string(),
  pull_request: pullRequestSchema,
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestUnassignedEventSchema = z.object({
  action: z.literal("unassigned"),
  number: z.number(),
  pull_request: pullRequestSchema,
  assignee: userSchema,
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestUnlabeledEventSchema = z.object({
  action: z.literal("unlabeled"),
  number: z.number(),
  pull_request: pullRequestSchema,
  label: labelSchema,
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestUnlockedEventSchema = z.object({
  action: z.literal("unlocked"),
  number: z.number(),
  pull_request: pullRequestSchema,
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestReviewRequestRemovedEventSchema = z.object({
  action: z.literal("review_request_removed"),
  number: z.number(),
  pull_request: pullRequestSchema,
  requested_reviewer: userSchema.optional(),
  requested_team: teamSchema.optional(),
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestReviewRequestedEventSchema = z.object({
  action: z.literal("review_requested"),
  number: z.number(),
  pull_request: pullRequestSchema,
  requested_reviewer: userSchema.optional(),
  requested_team: teamSchema.optional(),
  repository: repositorySchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
  sender: userSchema,
});

export const pullRequestEventSchema: z.ZodDiscriminatedUnion<
  "action",
  [
    typeof pullRequestAssignedEventSchema,
    typeof pullRequestAutoMergeDisabledEventSchema,
    typeof pullRequestAutoMergeEnabledEventSchema,
    typeof pullRequestClosedEventSchema,
    typeof pullRequestConvertedToDraftEventSchema,
    typeof pullRequestDequeuedEventSchema,
    typeof pullRequestEditedEventSchema,
    typeof pullRequestLabeledEventSchema,
    typeof pullRequestLockedEventSchema,
    typeof pullRequestOpenedEventSchema,
    typeof pullRequestQueuedEventSchema,
    typeof pullRequestReadyForReviewEventSchema,
    typeof pullRequestReopenedEventSchema,
    typeof pullRequestReviewRequestRemovedEventSchema,
    typeof pullRequestReviewRequestedEventSchema,
    typeof pullRequestSynchronizeEventSchema,
    typeof pullRequestUnassignedEventSchema,
    typeof pullRequestUnlabeledEventSchema,
    typeof pullRequestUnlockedEventSchema
  ]
> = z.discriminatedUnion("action", [
  pullRequestAssignedEventSchema,
  pullRequestAutoMergeDisabledEventSchema,
  pullRequestAutoMergeEnabledEventSchema,
  pullRequestClosedEventSchema,
  pullRequestConvertedToDraftEventSchema,
  pullRequestDequeuedEventSchema,
  pullRequestEditedEventSchema,
  pullRequestLabeledEventSchema,
  pullRequestLockedEventSchema,
  pullRequestOpenedEventSchema,
  pullRequestQueuedEventSchema,
  pullRequestReadyForReviewEventSchema,
  pullRequestReopenedEventSchema,
  pullRequestReviewRequestRemovedEventSchema,
  pullRequestReviewRequestedEventSchema,
  pullRequestSynchronizeEventSchema,
  pullRequestUnassignedEventSchema,
  pullRequestUnlabeledEventSchema,
  pullRequestUnlockedEventSchema,
]);
