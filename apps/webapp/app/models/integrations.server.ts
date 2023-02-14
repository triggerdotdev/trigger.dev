import type { InternalIntegration } from "@trigger.dev/integration-sdk";
import { getIntegrations as getInternalIntegrations } from "integration-catalog";

//todo get integrations for the service, and merge with the old ones

export function getIntegrations(showAdminOnly: boolean) {
  return getInternalIntegrations(showAdminOnly);
}

export function getIntegrationMetadatas(showAdminOnly: boolean) {
  return getInternalIntegrations(showAdminOnly).map((i) => i.metadata);
}

export function getIntegration(name: string) {
  return getIntegrations(true).find((i) => i.metadata.service === name);
}

export function getIntegrationMetadata(
  integrations: Array<InternalIntegration>,
  name: string
) {
  const integration = integrations.find((i) => i.metadata.service === name);
  return integration ? integration.metadata : undefined;
}
