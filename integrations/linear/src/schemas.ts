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

const IssueLabelDataSchema = z.object({
  archivedAt: z.coerce.date().optional().nullable(),
  color: z.string(),
  createdAt: z.coerce.date(),
  creatorId: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  id: z.string(),
  // isGroup: z.boolean(), // missing
  name: z.string(),
  organizationId: z.string(),
  parentId: z.string().optional().nullable(),
  teamId: z.string().optional().nullable(),
  updatedAt: z.coerce.date(),
});

const IssueDataSchema = z.object({
  archivedAt: z.coerce.date().optional().nullable(),
  assignee: z.object({ id: z.string(), name: z.string() }).optional().nullable(),
  assigneeId: z.string().optional().nullable(),
  autoArchivedAt: z.coerce.date().optional().nullable(),
  autoClosedAt: z.coerce.date().optional().nullable(),
  boardOrder: z.number(),
  canceledAt: z.coerce.date().optional().nullable(),
  completedAt: z.coerce.date().optional().nullable(),
  createdAt: z.coerce.date(),
  creatorId: z.string().optional().nullable(),
  cycleId: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  dueDate: z.coerce.date().optional().nullable(), // timeless
  estimate: z.number().optional().nullable(),
  favoriteId: z.string().optional().nullable(),
  id: z.string(),
  labelIds: z.array(z.string()),
  labels: z.array(IssueLabelDataSchema.pick({ id: true, color: true, name: true })),
  number: z.number(),
  parentId: z.string().optional().nullable(),
  previousIdentifiers: z.array(z.string()),
  priority: z.number(),
  priorityLabel: z.string(),
  projectId: z.string().optional().nullable(),
  sortOrder: z.number(),
  state: z.object({ id: z.string(), color: z.string(), name: z.string(), type: z.string() }),
  startedAt: z.coerce.date().optional().nullable(),
  stateId: z.string(),
  subIssueSortOrder: z.number().optional().nullable(),
  subscriberIds: z.array(z.string()),
  team: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  teamId: z.string(),
  title: z.string(),
  trashed: z.boolean().optional().nullable(),
  triagedAt: z.coerce.date().optional().nullable(),
  updatedAt: z.coerce.date(),
});

/** **WARNING:** Still in alpha - use with caution! */
const AttachmentDataSchema = z.object({
  archivedAt: z.coerce.date().optional().nullable(),
  createdAt: z.coerce.date(),
  creatorId: z.string().optional().nullable(),
  groupBySource: z.boolean(),
  id: z.string(),
  issueId: z.string(),
  metadata: z.object({}).passthrough(), // JSONObject
  source: z
    .object({
      type: z.string().nullable(),
      imageUrl: z.string().url().nullable(),
    })
    .passthrough()
    .partial()
    .nullable(), // JSONObject
  sourceType: z.string().optional().nullable(),
  subtitle: z.string().optional().nullable(),
  title: z.string(),
  updatedAt: z.coerce.date(),
  url: z.string().url(),
});

const CommentDataSchema = z.object({
  archivedAt: z.coerce.date().optional().nullable(),
  body: z.string(),
  botActorId: z.string().optional().nullable(),
  createdAt: z.coerce.date(),
  editedAt: z.string().optional().nullable(),
  id: z.string(),
  issue: IssueDataSchema.pick({ id: true, title: true }),
  issueId: z.string(),
  parentId: z.string().optional().nullable(),
  reactionData: z.array(z.object({}).passthrough()), // JSONObject
  updatedAt: z.coerce.date(),
  userId: z.string().optional().nullable(),
});

const ReactionDataSchema = z.object({
  archivedAt: z.coerce.date().optional().nullable(),
  comment: CommentDataSchema.pick({
    id: true,
    body: true,
    userId: true,
  })
    .optional()
    .nullable(), // missing from official schema
  createdAt: z.coerce.date(),
  emoji: z.string(),
  id: z.string(),
  updatedAt: z.coerce.date(),
  user: z.object({ id: z.string(), name: z.string() }).optional().nullable(),
  userId: z.string().optional().nullable(),
});

const MilestoneDataSchema = z.object({
  archivedAt: z.coerce.date().optional().nullable(),
  createdAt: z.coerce.date(),
  description: z.string().optional().nullable(),
  id: z.string(),
  name: z.string(),
  projectId: z.string().optional().nullable(),
  sortOrder: z.number(),
  targetDate: z.coerce.date().optional().nullable(), // timeless
  updatedAt: z.coerce.date(),
});

const RoadmapDataSchema = z.object({
  archivedAt: z.coerce.date().optional().nullable(),
  color: z.string().optional().nullable(),
  createdAt: z.coerce.date(),
  creatorId: z.string(),
  description: z.string().optional().nullable(),
  id: z.string(),
  name: z.string(),
  organizationId: z.string(),
  ownerId: z.string(),
  slugId: z.string(),
  sortOrder: z.number(),
  updatedAt: z.coerce.date(),
});

const ProjectDataSchema = z.object({
  archivedAt: z.coerce.date().optional().nullable(),
  autoArchivedAt: z.coerce.date().optional().nullable(),
  canceledAt: z.coerce.date().optional().nullable(),
  color: z.string(),
  completedAt: z.coerce.date().optional().nullable(),
  completedIssueCountHistory: z.array(z.number()),
  completedScopeHistory: z.array(z.number()),
  content: z.string().optional().nullable(),
  convertedFromIssueId: z.string().optional().nullable(),
  createdAt: z.coerce.date(),
  creatorId: z.string(),
  description: z.string(),
  icon: z.string().optional().nullable(),
  id: z.string(),
  inProgressScopeHistory: z.array(z.number()),
  integrationsSettingsId: z.string().optional().nullable(),
  issueCountHistory: z.array(z.number()),
  leadId: z.string(),
  memberIds: z.array(z.string()),
  milestones: z.array(MilestoneDataSchema.pick({ id: true, name: true })), // at projectMilestones key in official schema
  name: z.string(),
  progress: z.number().optional().nullable(), // missing, should be NonNullable
  projectUpdateRemindersPausedUntilAt: z.coerce.date().optional().nullable(),
  roadmaps: z
    .array(RoadmapDataSchema.pick({ id: true, name: true }))
    .optional()
    .nullable(), // missing from official schema
  scope: z.number().optional().nullable(), // missing, should be NonNullable
  scopeHistory: z.array(z.number()),
  slackIssueComments: z.boolean(),
  slackIssueStatuses: z.boolean(),
  slackNewIssue: z.boolean(),
  slugId: z.string(),
  sortOrder: z.string(),
  startDate: z.coerce.date().optional().nullable(), // timeless
  startedAt: z.coerce.date().optional().nullable(),
  state: z.string(),
  targetDate: z.coerce.date().optional().nullable(), // timeless
  teamIds: z.array(z.string()),
  trashed: z.boolean().optional().nullable(),
  updatedAt: z.coerce.date(),
});

const ProjectUpdateDataSchema = z.object({
  archivedAt: z.coerce.date().optional().nullable(),
  body: z.string(),
  createdAt: z.coerce.date(),
  // diff: z.any().optional().nullable(), // missing, "stringified" JSON but typed as Record
  editedAt: z.coerce.date().optional().nullable(),
  health: z.string(),
  id: z.string(),
  infoSnapshot: z.object({}).passthrough().optional().nullable(), // JSONObject, marked as "internal"
  project: ProjectDataSchema.pick({ id: true, name: true }),
  projectId: z.string(),
  roadmaps: z
    .array(RoadmapDataSchema.pick({ id: true, name: true }))
    .optional()
    .nullable(), // missing from official schema
  updatedAt: z.coerce.date(),
  user: z.object({ id: z.string(), name: z.string() }),
  userId: z.string(),
});

const CycleDataSchema = z.object({
  archivedAt: z.coerce.date().optional().nullable(),
  autoArchivedAt: z.coerce.date().optional().nullable(),
  completedAt: z.coerce.date().optional().nullable(),
  completedIssueCountHistory: z.array(z.number()),
  completedScopeHistory: z.array(z.number()),
  createdAt: z.coerce.date(),
  description: z.string().optional().nullable(),
  endsAt: z.coerce.date(),
  id: z.string(),
  inProgressScopeHistory: z.array(z.number()),
  issueCountHistory: z.array(z.number()),
  name: z.string().optional().nullable(),
  number: z.number(),
  progress: z.number().optional().nullable(), // missing, should be NonNullable
  scopeHistory: z.array(z.number()),
  startsAt: z.coerce.date(),
  teamId: z.string(),
  uncompletedIssuesUponCloseIds: z.array(z.string()),
  updatedAt: z.coerce.date(),
});

export const WebhookPayloadBaseSchema = z.object({
  action: WebhookActionTypeSchema,
  createdAt: z.coerce.date(),
  url: z.string().url().optional().nullable(),
  organizationId: z.string().optional().nullable(), // missing from official schema - workspace id?
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
