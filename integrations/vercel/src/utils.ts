import crypto from "crypto";
import { DeploymentEvent } from "./schemas";

export function sha1(data: Buffer, secret: string): string {
  return crypto.createHmac("sha1", secret).update(data).digest("hex");
}

export const deploymentProperties = (event: DeploymentEvent) => {
  const applicationUrl = event.payload.deployment.url.startsWith("https://")
    ? event.payload.deployment.url
    : `https://${event.payload.deployment.url}`;
  return [
    {
      label: "Project Name",
      text: event.payload.deployment.name,
      url: event.payload.links.project,
    },
    {
      label: "Deployment ID",
      text: event.payload.deployment.id,
      url: event.payload.links.deployment,
    },
    {
      label: "Application URL",
      text: "View Application",
      url: applicationUrl,
    },
  ];
};
