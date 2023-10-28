import { EventSpecificationExample } from "@trigger.dev/sdk";

import DeploymentCreated from "./DeploymentCreated.json";
import DeploymentSucceeded from "./DeploymentSucceeded.json";

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
