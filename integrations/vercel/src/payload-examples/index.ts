import { EventSpecificationExample } from "@trigger.dev/sdk";

import DeploymentCreated from "./DeploymentCreated.json";
import DeploymentSucceeded from "./DeploymentSucceeded.json";
import DeploymentReady from "./DeploymentReady.json";
import DeploymentCanceled from "./DeploymentCanceled.json";
import DeploymentError from "./DeploymentError.json";
import ProjectCreated from "./ProjectCreated.json";
import ProjectRemoved from "./ProjectRemoved.json";

export const deploymentCreated: EventSpecificationExample = {
  id: "deployment.created",
  name: "Deployment Created",
  payload: DeploymentCreated,
};

export const deploymentSucceeded: EventSpecificationExample = {
  id: "deployment.succeeded",
  name: "Deployment Succeeded",
  payload: DeploymentSucceeded,
};

export const deploymentReady: EventSpecificationExample = {
  id: "deployment.ready",
  name: "Deployment Ready",
  payload: DeploymentReady,
};

export const deploymentCanceled: EventSpecificationExample = {
  id: "deployment.canceled",
  name: "Deployment Canceled",
  payload: DeploymentCanceled,
};

export const deploymentError: EventSpecificationExample = {
  id: "deployment.error",
  name: "Deployment Error",
  payload: DeploymentError,
};

export const projectCreated: EventSpecificationExample = {
  id: "project.created",
  name: "Project Created",
  payload: ProjectCreated,
};

export const projectRemoved: EventSpecificationExample = {
  id: "project.removed",
  name: "Project Removed",
  payload: ProjectRemoved,
};
