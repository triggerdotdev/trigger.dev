import { resolveAuthFeatureControls } from "~/services/authFeatureControls";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";

function currentControls() {
  return resolveAuthFeatureControls(globalFlagsRegistry.current());
}

export const authFeatureControls = {
  additionalApiKeyLookupEnabled: () => currentControls().additionalApiKeyLookupEnabled,
};
