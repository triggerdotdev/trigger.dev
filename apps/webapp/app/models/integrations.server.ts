import { getProviders } from "@trigger.dev/providers";

export function getIntegrations(showAdminOnly: boolean) {
  return getProviders(showAdminOnly);
}
