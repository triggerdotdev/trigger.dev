import { EventSpecification } from "@trigger.dev/sdk";
import {
  AttachmentEvent,
  CommentEvent,
  CycleEvent,
  IssueEvent,
  IssueLabelEvent,
  IssueSLAEvent,
  ProjectEvent,
  ProjectUpdateEvent,
  ReactionEvent,
} from "./schemas";
import { ExtractCreate, ExtractRemove, ExtractUpdate } from "./types";
import {
  attachmentCreated,
  attachmentRemoved,
  attachmentUpdated,
  commentCreated,
  commentRemoved,
  commentUpdated,
  cycleCreated,
  cycleRemoved,
  cycleUpdated,
  issueCreated,
  issueRemoved,
  issueUpdated,
  issueLabelCreated,
  issueLabelRemoved,
  issueLabelUpdated,
  projectCreated,
  projectRemoved,
  projectUpdated,
  projectUpdateCreated,
  projectUpdateRemoved,
  projectUpdateUpdated,
  reactionCreated,
  reactionRemoved,
  reactionUpdated,
} from "./payload-examples";

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachment: EventSpecification<AttachmentEvent> = {
  name: "Attachment",
  title: "On Attachment",
  source: "linear.app",
  icon: "linear",
  examples: [attachmentCreated, attachmentRemoved, attachmentUpdated],
  parsePayload: (payload) => payload as AttachmentEvent,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "Attachment ID", text: payload.data.id },
  ],
};

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachmentCreated: EventSpecification<ExtractCreate<AttachmentEvent>> = {
  name: "Attachment",
  title: "On Attachment Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [attachmentCreated],
  parsePayload: (payload) => payload as ExtractCreate<AttachmentEvent>,
  runProperties: (payload) => [{ label: "Attachment ID", text: payload.data.id }],
};

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachmentRemoved: EventSpecification<ExtractRemove<AttachmentEvent>> = {
  name: "Attachment",
  title: "On Attachment Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [attachmentRemoved],
  parsePayload: (payload) => payload as ExtractRemove<AttachmentEvent>,
  runProperties: (payload) => [{ label: "Attachment ID", text: payload.data.id }],
};

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachmentUpdated: EventSpecification<ExtractUpdate<AttachmentEvent>> = {
  name: "Attachment",
  title: "On Attachment Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [attachmentUpdated],
  parsePayload: (payload) => payload as ExtractUpdate<AttachmentEvent>,
  runProperties: (payload) => [{ label: "Attachment ID", text: payload.data.id }],
};

export const onComment: EventSpecification<CommentEvent> = {
  name: "Comment",
  title: "On Comment",
  source: "linear.app",
  icon: "linear",
  examples: [commentCreated, commentRemoved, commentUpdated],
  parsePayload: (payload) => payload as CommentEvent,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "Comment ID", text: payload.data.id },
  ],
};

export const onCommentCreated: EventSpecification<ExtractCreate<CommentEvent>> = {
  name: "Comment",
  title: "On Comment Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [commentCreated],
  parsePayload: (payload) => payload as ExtractCreate<CommentEvent>,
  runProperties: (payload) => [{ label: "Comment ID", text: payload.data.id }],
};

export const onCommentRemoved: EventSpecification<ExtractRemove<CommentEvent>> = {
  name: "Comment",
  title: "On Comment Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [commentRemoved],
  parsePayload: (payload) => payload as ExtractRemove<CommentEvent>,
  runProperties: (payload) => [{ label: "Comment ID", text: payload.data.id }],
};

export const onCommentUpdated: EventSpecification<ExtractUpdate<CommentEvent>> = {
  name: "Comment",
  title: "On Comment Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [commentUpdated],
  parsePayload: (payload) => payload as ExtractUpdate<CommentEvent>,
  runProperties: (payload) => [{ label: "Comment ID", text: payload.data.id }],
};

export const onCycle: EventSpecification<CycleEvent> = {
  name: "Cycle",
  title: "On Cycle",
  source: "linear.app",
  icon: "linear",
  examples: [cycleCreated, cycleRemoved, cycleUpdated],
  parsePayload: (payload) => payload as CycleEvent,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "Cycle ID", text: payload.data.id },
  ],
};

export const onCycleCreated: EventSpecification<ExtractCreate<CycleEvent>> = {
  name: "Cycle",
  title: "On Cycle Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [cycleCreated],
  parsePayload: (payload) => payload as ExtractCreate<CycleEvent>,
  runProperties: (payload) => [{ label: "Cycle ID", text: payload.data.id }],
};

export const onCycleRemoved: EventSpecification<ExtractRemove<CycleEvent>> = {
  name: "Cycle",
  title: "On Cycle Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [cycleRemoved],
  parsePayload: (payload) => payload as ExtractRemove<CycleEvent>,
  runProperties: (payload) => [{ label: "Cycle ID", text: payload.data.id }],
};

export const onCycleUpdated: EventSpecification<ExtractUpdate<CycleEvent>> = {
  name: "Cycle",
  title: "On Cycle Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [cycleUpdated],
  parsePayload: (payload) => payload as ExtractUpdate<CycleEvent>,
  runProperties: (payload) => [{ label: "Cycle ID", text: payload.data.id }],
};

export const onIssue: EventSpecification<IssueEvent> = {
  name: "Issue",
  title: "On Issue",
  source: "linear.app",
  icon: "linear",
  examples: [issueCreated, issueRemoved, issueUpdated],
  parsePayload: (payload) => payload as IssueEvent,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "Issue ID", text: payload.data.id },
  ],
};

export const onIssueCreated: EventSpecification<ExtractCreate<IssueEvent>> = {
  name: "Issue",
  title: "On Issue Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [issueCreated],
  parsePayload: (payload) => payload as ExtractCreate<IssueEvent>,
  runProperties: (payload) => [{ label: "Issue ID", text: payload.data.id }],
};

export const onIssueRemoved: EventSpecification<ExtractRemove<IssueEvent>> = {
  name: "Issue",
  title: "On Issue Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [issueRemoved],
  parsePayload: (payload) => payload as ExtractRemove<IssueEvent>,
  runProperties: (payload) => [{ label: "Issue ID", text: payload.data.id }],
};

export const onIssueUpdated: EventSpecification<ExtractUpdate<IssueEvent>> = {
  name: "Issue",
  title: "On Issue Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [issueUpdated],
  parsePayload: (payload) => payload as ExtractUpdate<IssueEvent>,
  runProperties: (payload) => [{ label: "Issue ID", text: payload.data.id }],
};

export const onIssueLabel: EventSpecification<IssueLabelEvent> = {
  name: "IssueLabel",
  title: "On IssueLabel",
  source: "linear.app",
  icon: "linear",
  examples: [issueLabelCreated, issueLabelRemoved, issueLabelUpdated],
  parsePayload: (payload) => payload as IssueLabelEvent,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "IssueLabel ID", text: payload.data.id },
  ],
};

export const onIssueLabelCreated: EventSpecification<ExtractCreate<IssueLabelEvent>> = {
  name: "IssueLabel",
  title: "On IssueLabel Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [issueLabelCreated],
  parsePayload: (payload) => payload as ExtractCreate<IssueLabelEvent>,
  runProperties: (payload) => [{ label: "IssueLabel ID", text: payload.data.id }],
};

export const onIssueLabelRemoved: EventSpecification<ExtractRemove<IssueLabelEvent>> = {
  name: "IssueLabel",
  title: "On IssueLabel Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [issueLabelRemoved],
  parsePayload: (payload) => payload as ExtractRemove<IssueLabelEvent>,
  runProperties: (payload) => [{ label: "IssueLabel ID", text: payload.data.id }],
};

export const onIssueLabelUpdated: EventSpecification<ExtractUpdate<IssueLabelEvent>> = {
  name: "IssueLabel",
  title: "On IssueLabel Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [issueLabelUpdated],
  parsePayload: (payload) => payload as ExtractUpdate<IssueLabelEvent>,
  runProperties: (payload) => [{ label: "IssueLabel ID", text: payload.data.id }],
};

// TODO: this needs to be tested
export const onIssueSLA: EventSpecification<IssueSLAEvent> = {
  name: "IssueSLA",
  title: "On Issue SLA",
  source: "linear.app",
  icon: "linear",
  parsePayload: (payload) => payload as IssueSLAEvent,
  runProperties: (payload) => [
    { label: "SLA action", text: payload.action },
    { label: "Issue ID", text: payload.issueData.id },
  ],
};

export const onProject: EventSpecification<ProjectEvent> = {
  name: "Project",
  title: "On Project",
  source: "linear.app",
  icon: "linear",
  examples: [projectCreated, projectRemoved, projectUpdated],
  parsePayload: (payload) => payload as ProjectEvent,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "Project ID", text: payload.data.id },
  ],
};

export const onProjectCreated: EventSpecification<ExtractCreate<ProjectEvent>> = {
  name: "Project",
  title: "On Project Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [projectCreated],
  parsePayload: (payload) => payload as ExtractCreate<ProjectEvent>,
  runProperties: (payload) => [{ label: "Project ID", text: payload.data.id }],
};

export const onProjectRemoved: EventSpecification<ExtractRemove<ProjectEvent>> = {
  name: "Project",
  title: "On Project Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [projectRemoved],
  parsePayload: (payload) => payload as ExtractRemove<ProjectEvent>,
  runProperties: (payload) => [{ label: "Project ID", text: payload.data.id }],
};

// TODO: think of a better naming scheme (clashes with ProjectUpdated entity)
export const onProjectUpdated: EventSpecification<ExtractUpdate<ProjectEvent>> = {
  name: "Project",
  title: "On Project Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [projectUpdated],
  parsePayload: (payload) => payload as ExtractUpdate<ProjectEvent>,
  runProperties: (payload) => [{ label: "Project ID", text: payload.data.id }],
};

export const onProjectUpdate: EventSpecification<ProjectUpdateEvent> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate",
  source: "linear.app",
  icon: "linear",
  examples: [projectUpdateCreated, projectUpdateRemoved, projectUpdateUpdated],
  parsePayload: (payload) => payload as ProjectUpdateEvent,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "ProjectUpdate ID", text: payload.data.id },
  ],
};

export const onProjectUpdateCreated: EventSpecification<ExtractCreate<ProjectUpdateEvent>> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [projectUpdateCreated],
  parsePayload: (payload) => payload as ExtractCreate<ProjectUpdateEvent>,
  runProperties: (payload) => [{ label: "ProjectUpdate ID", text: payload.data.id }],
};

export const onProjectUpdateRemoved: EventSpecification<ExtractRemove<ProjectUpdateEvent>> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [projectUpdateRemoved],
  parsePayload: (payload) => payload as ExtractRemove<ProjectUpdateEvent>,
  runProperties: (payload) => [{ label: "ProjectUpdate ID", text: payload.data.id }],
};

export const onProjectUpdateUpdated: EventSpecification<ExtractUpdate<ProjectUpdateEvent>> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [projectUpdateUpdated],
  parsePayload: (payload) => payload as ExtractUpdate<ProjectUpdateEvent>,
  runProperties: (payload) => [{ label: "ProjectUpdate ID", text: payload.data.id }],
};

export const onReaction: EventSpecification<ReactionEvent> = {
  name: "Reaction",
  title: "On Reaction",
  source: "linear.app",
  icon: "linear",
  examples: [reactionCreated, reactionRemoved, reactionUpdated],
  parsePayload: (payload) => payload as ReactionEvent,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "Reaction ID", text: payload.data.id },
  ],
};

export const onReactionCreated: EventSpecification<ExtractCreate<ReactionEvent>> = {
  name: "Reaction",
  title: "On Reaction Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [reactionCreated],
  parsePayload: (payload) => payload as ExtractCreate<ReactionEvent>,
  runProperties: (payload) => [{ label: "Reaction ID", text: payload.data.id }],
};

export const onReactionRemoved: EventSpecification<ExtractRemove<ReactionEvent>> = {
  name: "Reaction",
  title: "On Reaction Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [reactionRemoved],
  parsePayload: (payload) => payload as ExtractRemove<ReactionEvent>,
  runProperties: (payload) => [{ label: "Reaction ID", text: payload.data.id }],
};

export const onReactionUpdated: EventSpecification<ExtractUpdate<ReactionEvent>> = {
  name: "Reaction",
  title: "On Reaction Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [reactionUpdated],
  parsePayload: (payload) => payload as ExtractUpdate<ReactionEvent>,
  runProperties: (payload) => [{ label: "Reaction ID", text: payload.data.id }],
};
