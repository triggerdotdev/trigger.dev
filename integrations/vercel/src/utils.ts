import { DeploymentEvent } from "./schemas";

export const deploymentProperties = (event: DeploymentEvent) => {
  return [
    { label: "Deployment ID", text: event.payload.deploymentId },
    { label: "Deployment URL", text: event.payload.deploymentUrl },
    { label: "Project Name", text: event.payload.projectName },
  ];
};
