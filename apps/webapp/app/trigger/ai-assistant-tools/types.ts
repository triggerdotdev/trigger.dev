// Matches the `withClientData` schema on the chat.agent definition.
export interface ClientData {
  userId: string;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  currentPage: string;
  currentParams?: Record<string, string>;
}

export interface ToolContext {
  clientData: ClientData;
  // Pre-built path objects for pathBuilder functions.
  org: { slug: string };
  project: { slug: string };
  env: { slug: string };
}

export function buildToolContext(clientData: ClientData): ToolContext {
  return {
    clientData,
    org: { slug: clientData.organizationSlug },
    project: { slug: clientData.projectSlug },
    env: { slug: clientData.environmentSlug },
  };
}