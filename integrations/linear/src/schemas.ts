import { z } from "zod";

export const WebhookResourceTypeSchema = z.union([
  z.literal("Attachment"),
  z.literal("Comment"),
  z.literal("Cycle"),
  z.literal("Issue"),
  z.literal("IssueLabel"),
  z.literal("Project"),
  z.literal("ProjectUpdate"),
  z.literal("Reaction"),
]);
export type WebhookResourceType = z.infer<typeof WebhookResourceTypeSchema>;

export const WebhookActionTypeSchema = z.union([
  z.literal("create"),
  z.literal("remove"),
  z.literal("update"),
]);
export type WebhookActionType = z.infer<typeof WebhookActionTypeSchema>;

const ReactionShortSchema = z.object({
  emoji: z.string(),
  reactions: z.array(
    z.object({
      id: z.string(),
      userId: z.string(),
      reactedAt: z.string(),
    })
  ),
});

const IssueDataSchema = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  number: z.number(),
  title: z.string(),
  priority: z.number(),
  boardOrder: z.number(),
  sortOrder: z.number(),
  teamId: z.string(),
  previousIdentifiers: z.array(z.string()),
  assigneeId: z.string().optional(),
  stateId: z.string(),
  priorityLabel: z.string(),
  subscriberIds: z.array(z.string()),
  labelIds: z.array(z.string()),
  assignee: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .optional(),
  state: z.object({
    id: z.string(),
    color: z.string(),
    name: z.string(),
    type: z.string(),
  }),
  team: z.object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
  }),
  labels: z.array(
    z.object({
      id: z.string(),
      color: z.string(),
      name: z.string(),
    })
  ),
  description: z.string(),
});

/** **WARNING:** Still in alpha - use with caution! */
const AttachmentDataSchema = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  title: z.string(),
  url: z.string().url(),
  creatorId: z.string(),
  metadata: z.object({}).passthrough(),
  source: z.object({
    type: z.string(),
    imageUrl: z.string().url(),
  }),
  sourceType: z.string(),
  groupBySource: z.boolean(),
  issueId: z.string(),
});

const CommentDataSchema = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  body: z.string(),
  issueId: z.string(),
  userId: z.string(),
  editedAt: z.string().optional(),
  reactionData: z.array(ReactionShortSchema),
  issue: z.object({
    id: z.string(),
    title: z.string(),
  }),
});

const IssueLabelDataSchema = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  name: z.string(),
  color: z.string(),
  organizationId: z.string(),
  teamId: z.string(),
  creatorId: z.string(),
});

const ReactionDataSchema = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  emoji: z.string(),
  userId: z.string(),
  comment: z.object({
    id: z.string(),
    body: z.string(),
    userId: z.string(),
  }),
  user: z.object({
    id: z.string(),
    name: z.string(),
  }),
});

const MilestoneDataSchema = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  name: z.string(),
  archivedAt: z.coerce.date().optional(),
  description: z.string().optional(),
  sortOrder: z.number().optional(),
  targetDate: z.coerce.date().optional(),
});

const RoadmapDataSchema = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  name: z.string(),
  color: z.string().optional(),
  archivedAt: z.coerce.date().optional(),
  description: z.string().optional(),
  sortOrder: z.number().optional(),
  targetDate: z.coerce.date().optional(),
});

const ProjectDataSchema = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  name: z.string(),
  description: z.string(),
  slugId: z.string(),
  color: z.string(),
  state: z.string(),
  creatorId: z.string(),
  leadId: z.string(),
  sortOrder: z.string(),
  issueCountHistory: z.array(z.number()),
  completedIssueCountHistory: z.array(z.number()),
  scopeHistory: z.array(z.number()),
  completedScopeHistory: z.array(z.number()),
  inProgressScopeHistory: z.array(z.number()),
  slackNewIssue: z.boolean(),
  slackIssueComments: z.boolean(),
  slackIssueStatuses: z.boolean(),
  teamIds: z.array(z.string()),
  memberIds: z.array(z.string()),
  milestones: z.array(MilestoneDataSchema.partial()),
  roadmaps: z.array(RoadmapDataSchema.partial()),
});

const ProjectUpdateDataSchema = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  body: z.string(),
  projectId: z.string(),
  health: z.string(),
  userId: z.string(),
  infoSnapshot: z.object({}).passthrough().optional(),
  project: ProjectDataSchema.pick({ id: true, name: true }),
  user: z.object({
    id: z.string(),
    name: z.string(),
  }),
  roadmaps: z.array(RoadmapDataSchema.partial()),
});

const CycleDataSchema = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  number: z.number(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  issueCountHistory: z.array(z.number()),
  completedIssueCountHistory: z.array(z.number()),
  scopeHistory: z.array(z.number()),
  completedScopeHistory: z.array(z.number()),
  inProgressScopeHistory: z.array(z.number()),
  teamId: z.string(),
  uncompletedIssuesUponCloseIds: z.array(z.string()),
});

export const WebhookPayloadBaseSchema = z.object({
  action: WebhookActionTypeSchema,
  createdAt: z.coerce.date(),
  url: z.string().url().optional(),
  // TODO: check if this is always present
  organizationId: z.string().optional(),
  webhookTimestamp: z.coerce.date(),
  webhookId: z.string(),
});

export const IssueEventSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("Issue"),
  data: IssueDataSchema,
  updatedFrom: IssueDataSchema.partial().optional(),
});
export type IssueEvent = z.infer<typeof IssueEventSchema>;

/** **WARNING:** Still in alpha - use with caution! */
export const AttachmentEventSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("Attachment"),
  data: AttachmentDataSchema,
  updatedFrom: AttachmentDataSchema.partial().optional(),
});
export type AttachmentEvent = z.infer<typeof AttachmentEventSchema>;

export const CommentEventSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("Comment"),
  data: CommentDataSchema,
  updatedFrom: CommentDataSchema.partial().optional(),
});
export type CommentEvent = z.infer<typeof CommentEventSchema>;

export const IssueLabelEventSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("IssueLabel"),
  data: IssueLabelDataSchema,
  updatedFrom: IssueLabelDataSchema.partial().optional(),
});
export type IssueLabelEvent = z.infer<typeof IssueLabelEventSchema>;

export const ReactionEventSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("Reaction"),
  data: ReactionDataSchema,
  updatedFrom: ReactionDataSchema.partial().optional(),
});
export type ReactionEvent = z.infer<typeof ReactionEventSchema>;

export const ProjectEventSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("Project"),
  data: ProjectDataSchema,
  updatedFrom: ProjectDataSchema.partial().optional(),
});
export type ProjectEvent = z.infer<typeof ProjectEventSchema>;

export const ProjectUpdateEventSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("ProjectUpdate"),
  data: ProjectUpdateDataSchema,
  updatedFrom: ProjectUpdateDataSchema.partial().optional(),
});
export type ProjectUpdateEvent = z.infer<typeof ProjectUpdateEventSchema>;

export const CycleEventSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("Cycle"),
  data: CycleDataSchema,
  updatedFrom: CycleDataSchema.partial().optional(),
});
export type CycleEvent = z.infer<typeof CycleEventSchema>;

export const WebhookPayloadSchema = z.discriminatedUnion("type", [
  IssueEventSchema,
  AttachmentEventSchema,
  CommentEventSchema,
  IssueLabelEventSchema,
  ReactionEventSchema,
  ProjectEventSchema,
  ProjectUpdateEventSchema,
  CycleEventSchema,
]);

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;
