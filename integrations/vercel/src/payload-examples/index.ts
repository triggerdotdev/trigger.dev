import { EventSpecificationExample } from "@trigger.dev/sdk";

import DeploymentCreated from "./DeploymentCreated.json";
import DeploymentSucceeded from "./DeploymentSucceeded.json";
import DeploymentReady from "./DeploymentReady.json";
import DeploymentCanceled from "./DeploymentCanceled.json";

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
