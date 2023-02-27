import fetch from "node-fetch";
import { TRIGGER_BASE_URL } from "../consts.js";

export type WhoamiResponse = {
  organizationId: number;
  env: string;
  organizationSlug: string;
};

export async function whoami(
  apiKey: string
): Promise<WhoamiResponse | undefined> {
  const response = await fetch(`${TRIGGER_BASE_URL}/api/v1/internal/whoami`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (response.ok) {
    return response.json() as Promise<WhoamiResponse>;
  }

  return;
}

export type TriggerTemplate = {
  id: string;
  slug: string;
  title: string;
  shortTitle: string;
  description: string;
  imageUrl: string;
  repositoryUrl: string;
  markdownDocs: string;
  runLocalDocs: string;
  priority: number;
  services: string[];
  workflowIds: string[];
  createdAt: string;
  updatedAt: string;
};

export async function getTemplates(): Promise<Array<TriggerTemplate>> {
  const response = await fetch(`${TRIGGER_BASE_URL}/api/v1/templates`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (response.ok) {
    return response.json() as Promise<Array<TriggerTemplate>>;
  }

  return [];
}

export type TelemetryEvent = {
  id: string;
  event: string;
  properties: Record<string | number, any>;
};

export async function sendTelemetry(event: TelemetryEvent, apiKey?: string) {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  await fetch(`${TRIGGER_BASE_URL}/api/v1/internal/telemetry`, {
    method: "POST",
    headers,
    body: JSON.stringify(event),
  });
}
