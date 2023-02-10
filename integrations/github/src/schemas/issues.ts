import { z } from "zod";
import {
  appSchema,
  authorAssociationSchema,
  installationLiteSchema,
  labelSchema,
  milestoneSchema,
  organizationSchema,
  reactionsSchema,
  repositorySchema,
  userSchema,
} from "./shared";

export const issueSchema = z.object({
  url: z.string(),
  repository_url: z.string(),
  labels_url: z.string(),
  comments_url: z.string(),
  events_url: z.string(),
  html_url: z.string(),
  id: z.number(),
  node_id: z.string(),
  number: z.number(),
  title: z.string(),
  user: userSchema,
  labels: z.array(labelSchema).optional(),
  state: z.union([z.literal("open"), z.literal("closed")]).optional(),
  locked: z.boolean().optional(),
  assignee: userSchema.optional().nullish(),
  assignees: z.array(userSchema),
  milestone: milestoneSchema.nullish(),
  comments: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullish(),
  author_association: authorAssociationSchema,
  active_lock_reason: z
    .union([
      z.literal("resolved"),
      z.literal("off-topic"),
      z.literal("too heated"),
      z.literal("spam"),
    ])
    .nullish(),
  draft: z.boolean().optional(),
  performed_via_github_app: appSchema.optional().nullish(),
  pull_request: z
    .object({
      url: z.string().optional(),
      html_url: z.string().optional(),
      diff_url: z.string().optional(),
      patch_url: z.string().optional(),
      merged_at: z.string().optional().nullish(),
    })
    .optional(),
  body: z.string().nullish(),
  reactions: reactionsSchema.optional(),
  timeline_url: z.string().optional(),
  state_reason: z.string().optional().nullish(),
});

export const issuesAssignedEventSchema = z.object({
  action: z.literal("assigned"),
  issue: issueSchema,
  assignee: userSchema.optional().nullish(),
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesClosedEventSchema = z.object({
  action: z.literal("closed"),
  issue: issueSchema.and(
    z.object({
      state: z.literal("closed"),
      closed_at: z.string(),
    })
  ),
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesDeletedEventSchema = z.object({
  action: z.literal("deleted"),
  issue: issueSchema,
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesDemilestonedEventSchema = z.object({
  action: z.literal("demilestoned"),
  issue: issueSchema.and(
    z.object({
      milestone: z.null(),
    })
  ),
  milestone: milestoneSchema,
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesEditedEventSchema = z.object({
  action: z.literal("edited"),
  issue: issueSchema,
  label: labelSchema.optional(),
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
  }),
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesLabeledEventSchema = z.object({
  action: z.literal("labeled"),
  issue: issueSchema,
  label: labelSchema.optional(),
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesLockedEventSchema = z.object({
  action: z.literal("locked"),
  issue: issueSchema.and(
    z.object({
      locked: z.literal(true),
      active_lock_reason: z
        .union([
          z.literal("resolved"),
          z.literal("off-topic"),
          z.literal("too heated"),
          z.literal("spam"),
        ])
        .nullish(),
    })
  ),
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesMilestonedEventSchema = z.object({
  action: z.literal("milestoned"),
  issue: issueSchema.and(
    z.object({
      milestone: milestoneSchema,
    })
  ),
  milestone: milestoneSchema,
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesOpenedEventSchema = z.object({
  action: z.literal("opened"),
  changes: z
    .object({
      old_issue: issueSchema,
      old_repository: repositorySchema,
    })
    .optional(),
  issue: issueSchema.and(
    z.object({
      state: z.literal("open"),
      closed_at: z.null(),
    })
  ),
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesPinnedEventSchema = z.object({
  action: z.literal("pinned"),
  issue: issueSchema,
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesReopenedEventSchema = z.object({
  action: z.literal("reopened"),
  issue: issueSchema.and(
    z.object({
      state: z.literal("open"),
    })
  ),
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesTransferredEventSchema = z.object({
  action: z.literal("transferred"),
  changes: z.object({
    new_issue: issueSchema,
    new_repository: repositorySchema,
  }),
  issue: issueSchema,
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesUnassignedEventSchema = z.object({
  action: z.literal("unassigned"),
  issue: issueSchema,
  assignee: userSchema.optional().nullish(),
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesUnlabeledEventSchema = z.object({
  action: z.literal("unlabeled"),
  issue: issueSchema,
  label: labelSchema.optional(),
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesUnlockedEventSchema = z.object({
  action: z.literal("unlocked"),
  issue: issueSchema.and(
    z.object({
      locked: z.literal(false),
      active_lock_reason: z.null().optional(),
    })
  ),
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesUnpinnedEventSchema = z.object({
  action: z.literal("unpinned"),
  issue: issueSchema,
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});

export const issuesEventSchema: z.ZodDiscriminatedUnion<
  "action",
  [
    typeof issuesAssignedEventSchema,
    typeof issuesClosedEventSchema,
    typeof issuesDeletedEventSchema,
    typeof issuesDemilestonedEventSchema,
    typeof issuesEditedEventSchema,
    typeof issuesLabeledEventSchema,
    typeof issuesLockedEventSchema,
    typeof issuesMilestonedEventSchema,
    typeof issuesOpenedEventSchema,
    typeof issuesPinnedEventSchema,
    typeof issuesReopenedEventSchema,
    typeof issuesTransferredEventSchema,
    typeof issuesUnassignedEventSchema,
    typeof issuesUnlabeledEventSchema,
    typeof issuesUnlockedEventSchema,
    typeof issuesUnpinnedEventSchema
  ]
> = z.discriminatedUnion("action", [
  issuesAssignedEventSchema,
  issuesClosedEventSchema,
  issuesDeletedEventSchema,
  issuesDemilestonedEventSchema,
  issuesEditedEventSchema,
  issuesLabeledEventSchema,
  issuesLockedEventSchema,
  issuesMilestonedEventSchema,
  issuesOpenedEventSchema,
  issuesPinnedEventSchema,
  issuesReopenedEventSchema,
  issuesTransferredEventSchema,
  issuesUnassignedEventSchema,
  issuesUnlabeledEventSchema,
  issuesUnlockedEventSchema,
  issuesUnpinnedEventSchema,
]);
