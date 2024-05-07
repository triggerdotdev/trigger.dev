import { env } from "./env.server";
import { requestUrl } from "./utils/requestUrl.server";

export type TriggerFeatures = {
  isManagedCloud: boolean;
  v3Enabled: boolean;
};

// If the request host is cloud.trigger.dev then we are on the managed cloud
// or if env.NODE_ENV is development
export function featuresForRequest(request: Request): TriggerFeatures {
  const url = requestUrl(request);

  const isManagedCloud =
    url.host === "cloud.trigger.dev" ||
    url.host === "test-cloud.trigger.dev" ||
    url.host === "internal.trigger.dev" ||
    process.env.CLOUD_ENV === "development";

  return {
    isManagedCloud,
    v3Enabled: env.V3_ENABLED === "true",
  };
}
