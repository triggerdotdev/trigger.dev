import { EventSpecification } from "@trigger.dev/sdk";
import { DeploymentCreatedEvent, DeploymentSucceededEvent } from "./schemas";
import { deploymentCreated, deploymentSucceeded } from "./payload-examples";
import { deploymentProperties } from "./utils";
import { WebhookEventTypeSchema } from "./types";

export const onDeploymentCreated: EventSpecification<DeploymentCreatedEvent> = {
  name: WebhookEventTypeSchema.enum["deployment.created"],
  title: "On Deployment Created",
  source: "vercel.app",
  icon: "vercel",
  examples: [deploymentCreated],
  parsePayload: (payload) => payload as DeploymentCreatedEvent,
  runProperties: (event) => deploymentProperties(event),
};

export const onDeploymentSucceeded: EventSpecification<DeploymentSucceededEvent> = {
  name: WebhookEventTypeSchema.enum["deployment.succeeded"],
  title: "On Deployment Succeeded",
  source: "vercel.app",
  icon: "vercel",
  examples: [deploymentSucceeded],
  parsePayload: (payload) => payload as DeploymentSucceededEvent,
  runProperties: (event) => deploymentProperties(event),
};
