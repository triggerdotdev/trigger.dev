import crypto from "crypto";
import { DeploymentEvent } from "./schemas";

export function sha1(data: Buffer, secret: string): string {
  return crypto.createHmac("sha1", secret).update(data).digest("hex");
}

export const deploymentProperties = (event: DeploymentEvent) => {
  return [
    {
      label: "Project Name",
      text: event.payload.projectName,
      url: event.payload.projectUrlOnDashboard,
    },
    {
      label: "Deployment ID",
      text: event.payload.deploymentId,
      url: event.payload.deploymentUrlOnDashboard,
    },
    {
      label: "Deployment URL",
      text: "View Application",
      url: event.payload.deploymentUrl,
    },
  ];
};
