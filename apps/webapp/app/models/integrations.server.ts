import type { InternalIntegration } from "@trigger.dev/integration-sdk";
import { getIntegrations as getInternalIntegrations } from "integration-catalog";

export function getIntegrations(showAdminOnly: boolean) {
  return getInternalIntegrations(showAdminOnly);
}

export function getIntegrationMetadatas(showAdminOnly: boolean) {
  return getInternalIntegrations(showAdminOnly).map((i) => i.metadata);
}

export function getIntegrationMetadata(
  integrations: Array<InternalIntegration>,
  name: string
) {
  const integration = integrations.find((i) => i.metadata.slug === name);
  return integration ? integration.metadata : undefined;
}
