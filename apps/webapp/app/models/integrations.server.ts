import type {
  InternalIntegration,
  ServiceMetadata,
} from "@trigger.dev/integration-sdk";
import { getIntegrations as getInternalIntegrations } from "integration-catalog";
import { integrationsClient } from "~/services/integrationsClient.server";

export function getVersion1Integrations(showAdminOnly: boolean) {
  return getInternalIntegrations(showAdminOnly);
}

export async function getServiceMetadatas(
  showAdminOnly: boolean
): Promise<Record<string, ServiceMetadata>> {
  let services: Record<string, ServiceMetadata> = {};
  //get the old integrations, and turn them into an object
  const v1IntegrationsMetadata = getInternalIntegrations(showAdminOnly).map(
    (i) => i.metadata
  );
  const v1IntegrationsMetadataObject = v1IntegrationsMetadata.reduce(
    (acc, curr) => {
      acc[curr.service] = curr;
      return acc;
    },
    {} as Record<string, InternalIntegration["metadata"]>
  );

  //get the new integrations, and turn them into an object
  const v2IntegrationsMetadata = await integrationsClient.services();

  services = {
    ...v1IntegrationsMetadataObject,
    ...v2IntegrationsMetadata.services,
  };

  return services;
}
