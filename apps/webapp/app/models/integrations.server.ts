import type {
  InternalIntegration,
  ServiceMetadata,
} from "@trigger.dev/integration-sdk";
import { getIntegrations as getInternalIntegrations } from "integration-catalog";

export function getVersion1Integrations(showAdminOnly: boolean) {
  return getInternalIntegrations(showAdminOnly);
}

//todo get metadata from the new integrations service and merge it with the old one
export async function getServiceMetadatas(
  showAdminOnly: boolean
): Promise<Record<string, ServiceMetadata>> {
  const v1IntegrationsMetadata = getInternalIntegrations(showAdminOnly).map(
    (i) => i.metadata
  );
  //turn the array into an object where the key is v1Integration.service value
  const v1IntegrationsMetadataObject = v1IntegrationsMetadata.reduce(
    (acc, curr) => {
      acc[curr.service] = curr;
      return acc;
    },
    {} as Record<string, InternalIntegration["metadata"]>
  );
  return v1IntegrationsMetadataObject;
}
