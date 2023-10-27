import { EventSpecificationExample } from "@trigger.dev/sdk";

import DeploymentCreated from "./DeploymentCreated.json";

export const deploymentCreated: EventSpecificationExample = {
  id: "deployment.created",
  name: "Deployment created",
  payload: DeploymentCreated,
};
