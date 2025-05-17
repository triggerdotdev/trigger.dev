import { requestUrl } from "./utils/requestUrl.server";

export type TriggerFeatures = {
  isManagedCloud: boolean;
};

function isManagedCloud(host: string): boolean {
  return (
    host === "cloud.trigger.dev" ||
    host === "test-cloud.trigger.dev" ||
    host === "internal.trigger.dev" ||
    process.env.CLOUD_ENV === "development"
  );
}

function featuresForHost(host: string): TriggerFeatures {
  return {
    isManagedCloud: isManagedCloud(host),
  };
}

export function featuresForRequest(request: Request): TriggerFeatures {
  const url = requestUrl(request);
  return featuresForUrl(url);
}

export function featuresForUrl(url: URL): TriggerFeatures {
  return featuresForHost(url.host);
}
