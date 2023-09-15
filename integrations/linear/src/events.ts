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
export const onAttachmentCreate: EventSpecification<AttachmentEvent> = {
  name: "Attachment",
  title: "On Attachment",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as AttachmentEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachmentRemove: EventSpecification<AttachmentEvent> = {
  name: "Attachment",
  title: "On Attachment Remove",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as AttachmentEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachmentUpdate: EventSpecification<AttachmentEvent> = {
  name: "Attachment",
  title: "On Attachment Update",
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

export const onCommentCreate: EventSpecification<CommentEvent> = {
  name: "Comment",
  title: "On Comment",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as CommentEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onCommentRemove: EventSpecification<CommentEvent> = {
  name: "Comment",
  title: "On Comment Remove",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as CommentEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onCommentUpdate: EventSpecification<CommentEvent> = {
  name: "Comment",
  title: "On Comment Update",
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

export const onCycleCreate: EventSpecification<CycleEvent> = {
  name: "Cycle",
  title: "On Cycle",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as CycleEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onCycleRemove: EventSpecification<CycleEvent> = {
  name: "Cycle",
  title: "On Cycle Remove",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as CycleEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onCycleUpdate: EventSpecification<CycleEvent> = {
  name: "Cycle",
  title: "On Cycle Update",
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

export const onIssueCreate: EventSpecification<IssueEvent> = {
  name: "Issue",
  title: "On Issue",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as IssueEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onIssueRemove: EventSpecification<IssueEvent> = {
  name: "Issue",
  title: "On Issue Remove",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as IssueEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onIssueUpdate: EventSpecification<IssueEvent> = {
  name: "Issue",
  title: "On Issue Update",
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

export const onIssueLabelCreate: EventSpecification<IssueLabelEvent> = {
  name: "IssueLabel",
  title: "On IssueLabel",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as IssueLabelEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onIssueLabelRemove: EventSpecification<IssueLabelEvent> = {
  name: "IssueLabel",
  title: "On IssueLabel Remove",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as IssueLabelEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onIssueLabelUpdate: EventSpecification<IssueLabelEvent> = {
  name: "IssueLabel",
  title: "On IssueLabel Update",
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

export const onProject_Create: EventSpecification<ProjectEvent> = {
  name: "Project",
  title: "On Project",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as ProjectEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onProject_Remove: EventSpecification<ProjectEvent> = {
  name: "Project",
  title: "On Project Remove",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as ProjectEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

// TODO: think of a better naming scheme (clashes with ProjectUpdate entity)
export const onProject_Update: EventSpecification<ProjectEvent> = {
  name: "Project",
  title: "On Project Update",
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

export const onProjectUpdateCreate: EventSpecification<ProjectUpdateEvent> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as ProjectUpdateEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onProjectUpdateRemove: EventSpecification<ProjectUpdateEvent> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate Remove",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as ProjectUpdateEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onProjectUpdateUpdate: EventSpecification<ProjectUpdateEvent> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate Update",
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

export const onReactionCreate: EventSpecification<ReactionEvent> = {
  name: "Reaction",
  title: "On Reaction",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  parsePayload: (payload) => payload as ReactionEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onReactionRemove: EventSpecification<ReactionEvent> = {
  name: "Reaction",
  title: "On Reaction Remove",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  parsePayload: (payload) => payload as ReactionEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};

export const onReactionUpdate: EventSpecification<ReactionEvent> = {
  name: "Reaction",
  title: "On Reaction Update",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  parsePayload: (payload) => payload as ReactionEvent,
  runProperties: (payload) => [{ label: "Change action", text: payload.action }],
};
