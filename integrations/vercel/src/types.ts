import { z } from "zod";
import * as events from "./events";
import { createDeploymentEventSource, createProjectEventSource } from "./sources";
import { ExternalSourceTrigger } from "@trigger.dev/sdk";

export const WebhookEventTypeSchema = z.enum([
  "deployment.created",
  "deployment.succeeded",
  "deployment.ready",
  "deployment.canceled",
  "deployment.error",
  "project.created",
  "project.removed",
]);

export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

export type DeploymentEvents = (typeof events)[
  | "onDeploymentCreated"
  | "onDeploymentSucceeded"
  | "onDeploymentCanceled"
  | "onDeploymentError"];

export type ProjectEvents = (typeof events)["onProjectCreated" | "onProjectRemoved"];

export type DeploymentTriggerParams = {
  teamId: string;
  projectIds?: string[];
};

export type ProjectTriggerParams = {
  teamId: string;
};

export type CreateDeploymentTriggerResult<TEventSpecification extends DeploymentEvents> =
  ExternalSourceTrigger<TEventSpecification, ReturnType<typeof createDeploymentEventSource>>;

export type CreateProjectTriggerResult<TEventSpecification extends ProjectEvents> =
  ExternalSourceTrigger<TEventSpecification, ReturnType<typeof createProjectEventSource>>;
