import { EventSpecification } from "@trigger.dev/sdk";
import { DeploymentCreatedEvent } from "./schemas";
import { deploymentCreated } from "./payload-examples";
import { deploymentProperties } from "./utils";

export const onDeploymentCreated: EventSpecification<DeploymentCreatedEvent> = {
  name: "Deployment",
  title: "On Deployment Created",
  source: "vercel.com",
  icon: "vercel",
  examples: [deploymentCreated],
  parsePayload: (payload) => payload as DeploymentCreatedEvent,
  runProperties: (event) => deploymentProperties(event),
};
