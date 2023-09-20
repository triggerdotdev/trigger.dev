import { z } from "zod";

export const WebhookResourceTypeSchema = z.union([
  z.literal("Attachment"),
  z.literal("Comment"),
  z.literal("Cycle"),
  z.literal("Issue"),
  z.literal("IssueLabel"),
  z.literal("IssueSLA"),
  z.literal("Project"),
  z.literal("ProjectUpdate"),
  z.literal("Reaction"),
]);
export type WebhookResourceType = z.infer<typeof WebhookResourceTypeSchema>;

export const WebhookChangeActionTypeSchema = z.union([
  z.literal("create"),
  z.literal("remove"),
  z.literal("update"),
]);
export type WebhookChangeActionType = z.infer<typeof WebhookChangeActionTypeSchema>;

export const WebhookSLAActionTypeSchema = z.union([
  z.literal("set"),
  z.literal("breached"),
  z.literal("highRisk"),
]);
export type WebhookSLAActionType = z.infer<typeof WebhookSLAActionTypeSchema>;

export const WebhookActionTypeSchema = WebhookChangeActionTypeSchema.or(WebhookSLAActionTypeSchema);
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
  sortOrder: z.number(),
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
  createdAt: z.coerce.date(),
  organizationId: z.string().optional().nullable(), // missing from official schema - workspace id?
  url: z.string().url().optional().nullable(),
  webhookId: z.string(),
  webhookTimestamp: z.coerce.date(),
});

const CREATE = z.literal("create");
const REMOVE = z.literal("remove");
const UPDATE = z.literal("update");

/** **WARNING:** Still in alpha - use with caution! */
export const AttachmentEventBaseSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("Attachment"),
  data: AttachmentDataSchema,
});
export const AttachmentEventSchema = z.discriminatedUnion("action", [
  AttachmentEventBaseSchema.extend({
    action: CREATE,
  }),
  AttachmentEventBaseSchema.extend({
    action: REMOVE,
  }),
  AttachmentEventBaseSchema.extend({
    action: UPDATE,
    updatedFrom: AttachmentDataSchema.partial(),
  }),
]);
export type AttachmentEvent = z.infer<typeof AttachmentEventSchema>;

export const CommentEventBaseSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("Comment"),
  data: CommentDataSchema,
});
export const CommentEventSchema = z.discriminatedUnion("action", [
  CommentEventBaseSchema.extend({
    action: CREATE,
  }),
  CommentEventBaseSchema.extend({
    action: REMOVE,
  }),
  CommentEventBaseSchema.extend({
    action: UPDATE,
    updatedFrom: CommentDataSchema.partial(),
  }),
]);
export type CommentEvent = z.infer<typeof CommentEventSchema>;

export const CycleEventBaseSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("Cycle"),
  data: CycleDataSchema,
});
export const CycleEventSchema = z.discriminatedUnion("action", [
  CycleEventBaseSchema.extend({
    action: CREATE,
  }),
  CycleEventBaseSchema.extend({
    action: REMOVE,
  }),
  CycleEventBaseSchema.extend({
    action: UPDATE,
    updatedFrom: CycleDataSchema.partial(),
  }),
]);
export type CycleEvent = z.infer<typeof CycleEventSchema>;

export const IssueEventBaseSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("Issue"),
  data: IssueDataSchema,
});
export const IssueEventSchema = z.discriminatedUnion("action", [
  IssueEventBaseSchema.extend({
    action: CREATE,
  }),
  IssueEventBaseSchema.extend({
    action: REMOVE,
  }),
  IssueEventBaseSchema.extend({
    action: UPDATE,
    updatedFrom: IssueDataSchema.partial(),
  }),
]);
export type IssueEvent = z.infer<typeof IssueEventSchema>;

export const IssueLabelEventBaseSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("IssueLabel"),
  data: IssueLabelDataSchema,
});
export const IssueLabelEventSchema = z.discriminatedUnion("action", [
  IssueLabelEventBaseSchema.extend({
    action: CREATE,
  }),
  IssueLabelEventBaseSchema.extend({
    action: REMOVE,
  }),
  IssueLabelEventBaseSchema.extend({
    action: UPDATE,
    updatedFrom: IssueLabelDataSchema.partial(),
  }),
]);
export type IssueLabelEvent = z.infer<typeof IssueLabelEventSchema>;

// TODO: confirm this with real-world payload(s)
export const IssueSLAEventBaseSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("IssueSLA"),
  issueData: IssueDataSchema,
});
export const IssueSLAEventSchema = z.discriminatedUnion("action", [
  IssueSLAEventBaseSchema.extend({
    action: z.literal("set"),
  }),
  IssueSLAEventBaseSchema.extend({
    action: z.literal("highRisk"),
  }),
  IssueSLAEventBaseSchema.extend({
    action: z.literal("breached"),
  }),
]);
export type IssueSLAEvent = z.infer<typeof IssueSLAEventSchema>;
export type IssueSLAEventBreached = Extract<IssueSLAEvent, { action: "breached" }>;

export const ProjectEventBaseSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("Project"),
  data: ProjectDataSchema,
});
export const ProjectEventSchema = z.discriminatedUnion("action", [
  ProjectEventBaseSchema.extend({
    action: CREATE,
  }),
  ProjectEventBaseSchema.extend({
    action: REMOVE,
  }),
  ProjectEventBaseSchema.extend({
    action: UPDATE,
    updatedFrom: ProjectDataSchema.partial(),
  }),
]);
export type ProjectEvent = z.infer<typeof ProjectEventSchema>;

export const ProjectUpdateEventBaseSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("ProjectUpdate"),
  data: ProjectUpdateDataSchema,
});
export const ProjectUpdateEventSchema = z.discriminatedUnion("action", [
  ProjectUpdateEventBaseSchema.extend({
    action: CREATE,
  }),
  ProjectUpdateEventBaseSchema.extend({
    action: REMOVE,
  }),
  ProjectUpdateEventBaseSchema.extend({
    action: UPDATE,
    updatedFrom: ProjectUpdateDataSchema.partial(),
  }),
]);
export type ProjectUpdateEvent = z.infer<typeof ProjectUpdateEventSchema>;

export const ReactionEventBaseSchema = WebhookPayloadBaseSchema.extend({
  type: z.literal("Reaction"),
  data: ReactionDataSchema,
});
export const ReactionEventSchema = z.discriminatedUnion("action", [
  ReactionEventBaseSchema.extend({
    action: CREATE,
  }),
  ReactionEventBaseSchema.extend({
    action: REMOVE,
  }),
  ReactionEventBaseSchema.extend({
    action: UPDATE,
    updatedFrom: ReactionDataSchema.partial(),
  }),
]);
export type ReactionEvent = z.infer<typeof ReactionEventSchema>;

export const WebhookPayloadSchema = z.union([
  AttachmentEventSchema,
  CommentEventSchema,
  CycleEventSchema,
  IssueEventSchema,
  IssueLabelEventSchema,
  IssueSLAEventSchema,
  ProjectEventSchema,
  ProjectUpdateEventSchema,
  ReactionEventSchema,
]);

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;
