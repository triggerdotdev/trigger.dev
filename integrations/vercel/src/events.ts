import { EventSpecification } from "@trigger.dev/sdk";
import {
  DeploymentCanceledEventPayload,
  DeploymentCreatedEventPayload,
  DeploymentReadyEventPayload,
  DeploymentSucceededEventPayload,
} from "./schemas";
import {
  deploymentCanceled,
  deploymentCreated,
  deploymentReady,
  deploymentSucceeded,
} from "./payload-examples";
import { deploymentProperties } from "./utils";
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
