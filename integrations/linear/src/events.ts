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
import { GetLinearPayload } from "./types";
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
import { onCommentProperties, onIssueProperties, updatedFromProperties } from "./utils";

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachment: EventSpecification<GetLinearPayload<AttachmentEvent>> = {
  name: "Attachment",
  title: "On Attachment",
  source: "linear.app",
  icon: "linear",
  examples: [attachmentCreated, attachmentRemoved, attachmentUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<AttachmentEvent>,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "Attachment ID", text: payload.data.id },
  ],
};

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachmentCreated: EventSpecification<GetLinearPayload<AttachmentEvent, "create">> =
  {
    name: "Attachment",
    title: "On Attachment Created",
    source: "linear.app",
    icon: "linear",
    filter: {
      action: ["create"],
    },
    examples: [attachmentCreated],
    parsePayload: (payload) => payload as GetLinearPayload<AttachmentEvent, "create">,
    runProperties: (payload) => [{ label: "Attachment ID", text: payload.data.id }],
  };

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachmentRemoved: EventSpecification<GetLinearPayload<AttachmentEvent, "remove">> =
  {
    name: "Attachment",
    title: "On Attachment Removed",
    source: "linear.app",
    icon: "linear",
    filter: {
      action: ["remove"],
    },
    examples: [attachmentRemoved],
    parsePayload: (payload) => payload as GetLinearPayload<AttachmentEvent, "remove">,
    runProperties: (payload) => [{ label: "Attachment ID", text: payload.data.id }],
  };

/** **WARNING:** Still in alpha - use with caution! */
export const onAttachmentUpdated: EventSpecification<GetLinearPayload<AttachmentEvent, "update">> =
  {
    name: "Attachment",
    title: "On Attachment Updated",
    source: "linear.app",
    icon: "linear",
    filter: {
      action: ["update"],
    },
    examples: [attachmentUpdated],
    parsePayload: (payload) => payload as GetLinearPayload<AttachmentEvent, "update">,
    runProperties: (payload) => [{ label: "Attachment ID", text: payload.data.id }],
  };

export const onComment: EventSpecification<GetLinearPayload<CommentEvent>> = {
  name: "Comment",
  title: "On Comment",
  source: "linear.app",
  icon: "linear",
  examples: [commentCreated, commentRemoved, commentUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<CommentEvent>,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    ...onCommentProperties(payload),
    ...updatedFromProperties(payload),
  ],
};

export const onCommentCreated: EventSpecification<GetLinearPayload<CommentEvent, "create">> = {
  name: "Comment",
  title: "On Comment Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [commentCreated],
  parsePayload: (payload) => payload as GetLinearPayload<CommentEvent, "create">,
  runProperties: (payload) => onCommentProperties(payload),
};

export const onCommentRemoved: EventSpecification<GetLinearPayload<CommentEvent, "remove">> = {
  name: "Comment",
  title: "On Comment Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [commentRemoved],
  parsePayload: (payload) => payload as GetLinearPayload<CommentEvent, "remove">,
  runProperties: (payload) => onCommentProperties(payload),
};

export const onCommentUpdated: EventSpecification<GetLinearPayload<CommentEvent, "update">> = {
  name: "Comment",
  title: "On Comment Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [commentUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<CommentEvent, "update">,
  runProperties: (payload) => [...onCommentProperties(payload), ...updatedFromProperties(payload)],
};

export const onCycle: EventSpecification<GetLinearPayload<CycleEvent>> = {
  name: "Cycle",
  title: "On Cycle",
  source: "linear.app",
  icon: "linear",
  examples: [cycleCreated, cycleRemoved, cycleUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<CycleEvent>,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "Cycle ID", text: payload.data.id },
  ],
};

export const onCycleCreated: EventSpecification<GetLinearPayload<CycleEvent, "create">> = {
  name: "Cycle",
  title: "On Cycle Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [cycleCreated],
  parsePayload: (payload) => payload as GetLinearPayload<CycleEvent, "create">,
  runProperties: (payload) => [{ label: "Cycle ID", text: payload.data.id }],
};

export const onCycleRemoved: EventSpecification<GetLinearPayload<CycleEvent, "remove">> = {
  name: "Cycle",
  title: "On Cycle Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [cycleRemoved],
  parsePayload: (payload) => payload as GetLinearPayload<CycleEvent, "remove">,
  runProperties: (payload) => [{ label: "Cycle ID", text: payload.data.id }],
};

export const onCycleUpdated: EventSpecification<GetLinearPayload<CycleEvent, "update">> = {
  name: "Cycle",
  title: "On Cycle Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [cycleUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<CycleEvent, "update">,
  runProperties: (payload) => [{ label: "Cycle ID", text: payload.data.id }],
};

export const onIssue: EventSpecification<GetLinearPayload<IssueEvent>> = {
  name: "Issue",
  title: "On Issue",
  source: "linear.app",
  icon: "linear",
  examples: [issueCreated, issueRemoved, issueUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<IssueEvent>,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    ...onIssueProperties(payload),
    ...updatedFromProperties(payload),
  ],
};

export const onIssueCreated: EventSpecification<GetLinearPayload<IssueEvent, "create">> = {
  name: "Issue",
  title: "On Issue Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [issueCreated],
  parsePayload: (payload) => payload as GetLinearPayload<IssueEvent, "create">,
  runProperties: (payload) => onIssueProperties(payload),
};

export const onIssueRemoved: EventSpecification<GetLinearPayload<IssueEvent, "remove">> = {
  name: "Issue",
  title: "On Issue Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [issueRemoved],
  parsePayload: (payload) => payload as GetLinearPayload<IssueEvent, "remove">,
  runProperties: (payload) => onIssueProperties(payload),
};

export const onIssueUpdated: EventSpecification<GetLinearPayload<IssueEvent, "update">> = {
  name: "Issue",
  title: "On Issue Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [issueUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<IssueEvent, "update">,
  runProperties: (payload) => [...onIssueProperties(payload), ...updatedFromProperties(payload)],
};

export const onIssueLabel: EventSpecification<GetLinearPayload<IssueLabelEvent>> = {
  name: "IssueLabel",
  title: "On IssueLabel",
  source: "linear.app",
  icon: "linear",
  examples: [issueLabelCreated, issueLabelRemoved, issueLabelUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<IssueLabelEvent>,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "IssueLabel ID", text: payload.data.id },
  ],
};

export const onIssueLabelCreated: EventSpecification<GetLinearPayload<IssueLabelEvent, "create">> =
  {
    name: "IssueLabel",
    title: "On IssueLabel Created",
    source: "linear.app",
    icon: "linear",
    filter: {
      action: ["create"],
    },
    examples: [issueLabelCreated],
    parsePayload: (payload) => payload as GetLinearPayload<IssueLabelEvent, "create">,
    runProperties: (payload) => [{ label: "IssueLabel ID", text: payload.data.id }],
  };

export const onIssueLabelRemoved: EventSpecification<GetLinearPayload<IssueLabelEvent, "remove">> =
  {
    name: "IssueLabel",
    title: "On IssueLabel Removed",
    source: "linear.app",
    icon: "linear",
    filter: {
      action: ["remove"],
    },
    examples: [issueLabelRemoved],
    parsePayload: (payload) => payload as GetLinearPayload<IssueLabelEvent, "remove">,
    runProperties: (payload) => [{ label: "IssueLabel ID", text: payload.data.id }],
  };

export const onIssueLabelUpdated: EventSpecification<GetLinearPayload<IssueLabelEvent, "update">> =
  {
    name: "IssueLabel",
    title: "On IssueLabel Updated",
    source: "linear.app",
    icon: "linear",
    filter: {
      action: ["update"],
    },
    examples: [issueLabelUpdated],
    parsePayload: (payload) => payload as GetLinearPayload<IssueLabelEvent, "update">,
    runProperties: (payload) => [{ label: "IssueLabel ID", text: payload.data.id }],
  };

// TODO: this needs to be tested
export const onIssueSLA: EventSpecification<GetLinearPayload<IssueSLAEvent>> = {
  name: "IssueSLA",
  title: "On Issue SLA",
  source: "linear.app",
  icon: "linear",
  parsePayload: (payload) => payload as GetLinearPayload<IssueSLAEvent>,
  runProperties: (payload) => [
    { label: "SLA action", text: payload.action },
    { label: "Issue ID", text: payload.issueData.id },
  ],
};

export const onIssueSLASet: EventSpecification<GetLinearPayload<IssueSLAEvent, "set">> = {
  name: "IssueSLA",
  title: "On Issue SLA Set",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["set"],
  },
  parsePayload: (payload) => payload as GetLinearPayload<IssueSLAEvent, "set">,
  runProperties: (payload) => [{ label: "Issue ID", text: payload.issueData.id }],
};

export const onIssueSLABreached: EventSpecification<GetLinearPayload<IssueSLAEvent, "breached">> = {
  name: "IssueSLA",
  title: "On Issue SLA Breached",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["breached"],
  },
  parsePayload: (payload) => payload as GetLinearPayload<IssueSLAEvent, "breached">,
  runProperties: (payload) => [{ label: "Issue ID", text: payload.issueData.id }],
};

export const onIssueSLAHighRisk: EventSpecification<GetLinearPayload<IssueSLAEvent, "highRisk">> = {
  name: "IssueSLA",
  title: "On Issue SLA High Risk",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["highRisk"],
  },
  parsePayload: (payload) => payload as GetLinearPayload<IssueSLAEvent, "highRisk">,
  runProperties: (payload) => [{ label: "Issue ID", text: payload.issueData.id }],
};

export const onProject: EventSpecification<GetLinearPayload<ProjectEvent>> = {
  name: "Project",
  title: "On Project",
  source: "linear.app",
  icon: "linear",
  examples: [projectCreated, projectRemoved, projectUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<ProjectEvent>,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "Project ID", text: payload.data.id },
    { label: "Project Name", text: payload.data.name, url: payload.url ?? undefined },
    ...updatedFromProperties(payload),
  ],
};

export const onProjectCreated: EventSpecification<GetLinearPayload<ProjectEvent, "create">> = {
  name: "Project",
  title: "On Project Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [projectCreated],
  parsePayload: (payload) => payload as GetLinearPayload<ProjectEvent, "create">,
  runProperties: (payload) => [
    { label: "Project ID", text: payload.data.id },
    { label: "Project Name", text: payload.data.name, url: payload.url ?? undefined },
  ],
};

export const onProjectRemoved: EventSpecification<GetLinearPayload<ProjectEvent, "remove">> = {
  name: "Project",
  title: "On Project Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [projectRemoved],
  parsePayload: (payload) => payload as GetLinearPayload<ProjectEvent, "remove">,
  runProperties: (payload) => [
    { label: "Project ID", text: payload.data.id },
    { label: "Project Name", text: payload.data.name, url: payload.url ?? undefined },
  ],
};

export const onProjectUpdated: EventSpecification<GetLinearPayload<ProjectEvent, "update">> = {
  name: "Project",
  title: "On Project Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [projectUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<ProjectEvent, "update">,
  runProperties: (payload) => [
    { label: "Project ID", text: payload.data.id },
    { label: "Project Name", text: payload.data.name, url: payload.url ?? undefined },
    ...updatedFromProperties(payload),
  ],
};

export const onProjectUpdate: EventSpecification<GetLinearPayload<ProjectUpdateEvent>> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate",
  source: "linear.app",
  icon: "linear",
  examples: [projectUpdateCreated, projectUpdateRemoved, projectUpdateUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<ProjectUpdateEvent>,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "ProjectUpdate ID", text: payload.data.id },
  ],
};

export const onProjectUpdateCreated: EventSpecification<
  GetLinearPayload<ProjectUpdateEvent, "create">
> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [projectUpdateCreated],
  parsePayload: (payload) => payload as GetLinearPayload<ProjectUpdateEvent, "create">,
  runProperties: (payload) => [{ label: "ProjectUpdate ID", text: payload.data.id }],
};

export const onProjectUpdateRemoved: EventSpecification<
  GetLinearPayload<ProjectUpdateEvent, "remove">
> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [projectUpdateRemoved],
  parsePayload: (payload) => payload as GetLinearPayload<ProjectUpdateEvent, "remove">,
  runProperties: (payload) => [{ label: "ProjectUpdate ID", text: payload.data.id }],
};

export const onProjectUpdateUpdated: EventSpecification<
  GetLinearPayload<ProjectUpdateEvent, "update">
> = {
  name: "ProjectUpdate",
  title: "On ProjectUpdate Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [projectUpdateUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<ProjectUpdateEvent, "update">,
  runProperties: (payload) => [{ label: "ProjectUpdate ID", text: payload.data.id }],
};

export const onReaction: EventSpecification<GetLinearPayload<ReactionEvent>> = {
  name: "Reaction",
  title: "On Reaction",
  source: "linear.app",
  icon: "linear",
  examples: [reactionCreated, reactionRemoved, reactionUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<ReactionEvent>,
  runProperties: (payload) => [
    { label: "Event action", text: payload.action },
    { label: "Reaction ID", text: payload.data.id },
  ],
};

export const onReactionCreated: EventSpecification<GetLinearPayload<ReactionEvent, "create">> = {
  name: "Reaction",
  title: "On Reaction Created",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["create"],
  },
  examples: [reactionCreated],
  parsePayload: (payload) => payload as GetLinearPayload<ReactionEvent, "create">,
  runProperties: (payload) => [{ label: "Reaction ID", text: payload.data.id }],
};

export const onReactionRemoved: EventSpecification<GetLinearPayload<ReactionEvent, "remove">> = {
  name: "Reaction",
  title: "On Reaction Removed",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["remove"],
  },
  examples: [reactionRemoved],
  parsePayload: (payload) => payload as GetLinearPayload<ReactionEvent, "remove">,
  runProperties: (payload) => [{ label: "Reaction ID", text: payload.data.id }],
};

export const onReactionUpdated: EventSpecification<GetLinearPayload<ReactionEvent, "update">> = {
  name: "Reaction",
  title: "On Reaction Updated",
  source: "linear.app",
  icon: "linear",
  filter: {
    action: ["update"],
  },
  examples: [reactionUpdated],
  parsePayload: (payload) => payload as GetLinearPayload<ReactionEvent, "update">,
  runProperties: (payload) => [{ label: "Reaction ID", text: payload.data.id }],
};
