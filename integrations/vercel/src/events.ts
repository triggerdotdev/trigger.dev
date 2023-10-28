import { EventSpecification } from "@trigger.dev/sdk";
import {
  DeploymentCanceledEventPayload,
  DeploymentCreatedEventPayload,
  DeploymentErrorEventPayload,
  DeploymentReadyEventPayload,
  DeploymentSucceededEventPayload,
  ProjectCreatedEventPayload,
  ProjectRemovedEventPayload,
} from "./schemas";
import {
  deploymentCanceled,
  deploymentCreated,
  deploymentError,
  deploymentReady,
  deploymentSucceeded,
  projectCreated,
  projectRemoved,
} from "./payload-examples";
import { deploymentProperties, projectProperties } from "./utils";
import { WebhookEventTypeSchema } from "./types";

export const onDeploymentCreated: EventSpecification<DeploymentCreatedEventPayload> = {
  name: WebhookEventTypeSchema.enum["deployment.created"],
  title: "On Deployment Created",
  source: "vercel.app",
  icon: "vercel",
  examples: [deploymentCreated],
  parsePayload: (payload) => payload as DeploymentCreatedEventPayload,
  runProperties: (event) => deploymentProperties(event),
};

export const onDeploymentSucceeded: EventSpecification<DeploymentSucceededEventPayload> = {
  name: WebhookEventTypeSchema.enum["deployment.succeeded"],
  title: "On Deployment Succeeded",
  source: "vercel.app",
  icon: "vercel",
  examples: [deploymentSucceeded],
  parsePayload: (payload) => payload as DeploymentSucceededEventPayload,
  runProperties: (event) => deploymentProperties(event),
};

export const onDeploymentReady: EventSpecification<DeploymentReadyEventPayload> = {
  name: WebhookEventTypeSchema.enum["deployment.ready"],
  title: "On Deployment Ready",
  source: "vercel.app",
  icon: "vercel",
  examples: [deploymentReady],
  parsePayload: (payload) => payload as DeploymentReadyEventPayload,
  runProperties: (event) => deploymentProperties(event),
};

export const onDeploymentCanceled: EventSpecification<DeploymentCanceledEventPayload> = {
  name: WebhookEventTypeSchema.enum["deployment.canceled"],
  title: "On Deployment Canceled",
  source: "vercel.app",
  icon: "vercel",
  examples: [deploymentCanceled],
  parsePayload: (payload) => payload as DeploymentCanceledEventPayload,
  runProperties: (event) => deploymentProperties(event),
};

export const onDeploymentError: EventSpecification<DeploymentErrorEventPayload> = {
  name: WebhookEventTypeSchema.enum["deployment.error"],
  title: "On Deployment Error",
  source: "vercel.app",
  icon: "vercel",
  examples: [deploymentError],
  parsePayload: (payload) => payload as DeploymentErrorEventPayload,
  runProperties: (event) => deploymentProperties(event),
};

export const onProjectCreated: EventSpecification<ProjectCreatedEventPayload> = {
  name: WebhookEventTypeSchema.enum["project.created"],
  title: "On Project Created",
  source: "vercel.app",
  icon: "vercel",
  examples: [projectCreated],
  parsePayload: (payload) => payload as ProjectCreatedEventPayload,
  runProperties: (event) => projectProperties(event),
};

export const onProjectRemoved: EventSpecification<ProjectRemovedEventPayload> = {
  name: WebhookEventTypeSchema.enum["project.removed"],
  title: "On Project Removed",
  source: "vercel.app",
  icon: "vercel",
  examples: [projectRemoved],
  parsePayload: (payload) => payload as ProjectRemovedEventPayload,
  runProperties: (event) => projectProperties(event),
};
