import { requestUrl } from "./utils";

export type TriggerFeatures = {
  isManagedCloud: boolean;
};

// If the request host is cloud.trigger.dev then we are on the managed cloud
// or if env.NODE_ENV is development
export function featuresForRequest(request: Request): TriggerFeatures {
  const url = requestUrl(request);

  const isManagedCloud =
    url.host === "cloud.trigger.dev" ||
    url.host === "test-cloud.trigger.dev" ||
    process.env.NODE_ENV === "development";

  return {
    isManagedCloud,
  };
}
