import { resolveAuthFeatureControls } from "~/services/authFeatureControls";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";

export { resolveAuthFeatureControls } from "~/services/authFeatureControls";
export type { AuthFeatureControls } from "~/services/authFeatureControls";

function currentControls() {
  return resolveAuthFeatureControls(globalFlagsRegistry.current());
}

export const authFeatureControls = {
  additionalApiKeyLookupEnabled: () => currentControls().additionalApiKeyLookupEnabled,
};
