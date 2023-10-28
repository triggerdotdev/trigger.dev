import crypto from "crypto";
import { DeploymentEventPayload, ProjectEventPayload } from "./schemas";

export function sha1(data: Buffer, secret: string): string {
  return crypto.createHmac("sha1", secret).update(data).digest("hex");
}

export const deploymentProperties = (payload: DeploymentEventPayload) => {
  const applicationUrl = payload.deployment.url.startsWith("https://")
    ? payload.deployment.url
    : `https://${payload.deployment.url}`;
  return [
    {
      label: "Project Name",
      text: payload.deployment.name,
      url: payload.links.project,
    },
    {
      label: "Deployment ID",
      text: payload.deployment.id,
      url: payload.links.deployment,
    },
    {
      label: "Application URL",
      text: "View Application",
      url: applicationUrl,
    },
  ];
};

export const projectProperties = (payload: ProjectEventPayload) => {
  return [
    {
      label: "Project ID",
      text: payload.project.id,
    },
    {
      label: "Project Name",
      text: payload.project.name,
    },
  ];
};
