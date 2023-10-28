import { EventSpecification } from "@trigger.dev/sdk";
import { DeploymentCreatedEventPayload, DeploymentSucceededEventPayload } from "./schemas";
import { deploymentCreated, deploymentSucceeded } from "./payload-examples";
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
