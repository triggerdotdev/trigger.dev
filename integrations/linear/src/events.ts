import { EventSpecification } from "@trigger.dev/sdk";
import {
  AttachmentEvent,
  CommentEvent,
  CycleEvent,
  IssueEvent,
  IssueLabelEvent,
  ProjectEvent,
  ProjectUpdateEvent,
  ReactionEvent,
} from "./schemas";

// TODO: payload examples
// TODO: useful properties
// TODO: Issue SLA event

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachment: EventSpecification<AttachmentEvent> = {
  name: "Attachment",
  title: "On Attachment",
  source: "linear.app",
  icon: "linear",
  parsePayload: (payload) => payload as AttachmentEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachmentCreated: EventSpecification<AttachmentEvent> = {
  name: "Attachment",
  title: "On Attachment Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as AttachmentEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachmentRemoved: EventSpecification<AttachmentEvent> = {
  name: "Attachment",
  title: "On Attachment Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as AttachmentEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachmentUpdated: EventSpecification<AttachmentEvent> = {
  name: "Attachment",
  title: "On Attachment Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  parsePayload: (payload) => payload as AttachmentEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onComment: EventSpecification<CommentEvent> = {
  name: "Comment",
  title: "On Comment",
  source: "linear.app",
  icon: "linear",
  parsePayload: (payload) => payload as CommentEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onCommentCreated: EventSpecification<CommentEvent> = {
  name: "Comment",
  title: "On Comment Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as CommentEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onCommentRemoved: EventSpecification<CommentEvent> = {
  name: "Comment",
  title: "On Comment Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as CommentEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onCommentUpdated: EventSpecification<CommentEvent> = {
  name: "Comment",
  title: "On Comment Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  parsePayload: (payload) => payload as CommentEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onCycle: EventSpecification<CycleEvent> = {
  name: "Cycle",
  title: "On Cycle",
  source: "linear.app",
  icon: "linear",
  parsePayload: (payload) => payload as CycleEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onCycleCreated: EventSpecification<CycleEvent> = {
  name: "Cycle",
  title: "On Cycle Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as CycleEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onCycleRemoved: EventSpecification<CycleEvent> = {
  name: "Cycle",
  title: "On Cycle Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as CycleEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onCycleUpdated: EventSpecification<CycleEvent> = {
  name: "Cycle",
  title: "On Cycle Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  parsePayload: (payload) => payload as CycleEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onIssue: EventSpecification<IssueEvent> = {
  name: "Issue",
  title: "On Issue",
  source: "linear.app",
  icon: "linear",
  parsePayload: (payload) => payload as IssueEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onIssueCreated: EventSpecification<IssueEvent> = {
  name: "Issue",
  title: "On Issue Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as IssueEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onIssueRemoved: EventSpecification<IssueEvent> = {
  name: "Issue",
  title: "On Issue Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as IssueEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onIssueUpdated: EventSpecification<IssueEvent> = {
  name: "Issue",
  title: "On Issue Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  parsePayload: (payload) => payload as IssueEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onIssueLabel: EventSpecification<IssueLabelEvent> = {
  name: "IssueLabel",
  title: "On IssueLabel",
  source: "linear.app",
  icon: "linear",
  parsePayload: (payload) => payload as IssueLabelEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onIssueLabelCreated: EventSpecification<IssueLabelEvent> = {
  name: "IssueLabel",
  title: "On IssueLabel Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as IssueLabelEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onIssueLabelRemoved: EventSpecification<IssueLabelEvent> = {
  name: "IssueLabel",
  title: "On IssueLabel Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as IssueLabelEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onIssueLabelUpdated: EventSpecification<IssueLabelEvent> = {
  name: "IssueLabel",
  title: "On IssueLabel Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  parsePayload: (payload) => payload as IssueLabelEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onProject: EventSpecification<ProjectEvent> = {
  name: "Project",
  title: "On Project",
  source: "linear.app",
  icon: "linear",
  parsePayload: (payload) => payload as ProjectEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onProjectCreated: EventSpecification<ProjectEvent> = {
  name: "Project",
  title: "On Project Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as ProjectEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onProjectRemoved: EventSpecification<ProjectEvent> = {
  name: "Project",
  title: "On Project Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as ProjectEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

// TODO: think of a better naming scheme (clashes with ProjectUpdated entity)
export const onProjectUpdated: EventSpecification<ProjectEvent> = {
  name: "Project",
  title: "On Project Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  parsePayload: (payload) => payload as ProjectEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onProjectUpdate: EventSpecification<ProjectUpdateEvent> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate",
  source: "linear.app",
  icon: "linear",
  parsePayload: (payload) => payload as ProjectUpdateEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onProjectUpdateCreated: EventSpecification<ProjectUpdateEvent> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as ProjectUpdateEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onProjectUpdateRemoved: EventSpecification<ProjectUpdateEvent> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as ProjectUpdateEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onProjectUpdateUpdated: EventSpecification<ProjectUpdateEvent> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  parsePayload: (payload) => payload as ProjectUpdateEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onReaction: EventSpecification<ReactionEvent> = {
  name: "Reaction",
  title: "On Reaction",
  source: "linear.app",
  icon: "linear",
  parsePayload: (payload) => payload as ReactionEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onReactionCreated: EventSpecification<ReactionEvent> = {
  name: "Reaction",
  title: "On Reaction Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as ReactionEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onReactionRemoved: EventSpecification<ReactionEvent> = {
  name: "Reaction",
  title: "On Reaction Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as ReactionEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onReactionUpdated: EventSpecification<ReactionEvent> = {
  name: "Reaction",
  title: "On Reaction Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  parsePayload: (payload) => payload as ReactionEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};
