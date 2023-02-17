import type { InternalIntegration } from "@trigger.dev/integration-sdk";
import { getIntegrations as getInternalIntegrations } from "integration-catalog";
import invariant from "tiny-invariant";

export function getIntegrations(showAdminOnly: boolean) {
  return getInternalIntegrations(showAdminOnly);
}

export function getIntegrationMetadatas(showAdminOnly: boolean) {
  return getInternalIntegrations(showAdminOnly).map((i) => i.metadata);
}

export function getIntegration(name: string) {
  return getIntegrations(true).find((i) => i.metadata.slug === name);
}

export function getIntegrationMetadata(
  integrations: Array<InternalIntegration>,
  name: string
) {
  const integration = integrations.find((i) => i.metadata.slug === name);
  return integration ? integration.metadata : undefined;
}

export function getIntegrationMetadataByService(service: string) {
  const integrations = getIntegrationMetadatas(true);

  const metadata = integrations.find((i) => i.slug.includes(service));

  invariant(metadata, `Integration not found for service ${service}`);

  return metadata;
}
