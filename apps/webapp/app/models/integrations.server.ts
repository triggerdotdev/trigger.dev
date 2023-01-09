import { getProviders } from "internal-providers";

export function getIntegrations(showAdminOnly: boolean) {
  return getProviders(showAdminOnly);
}
