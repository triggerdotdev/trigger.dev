import { env } from "./env.server";
import { requestUrl } from "./utils/requestUrl.server";

export type TriggerFeatures = {
  isManagedCloud: boolean;
  hasPrivateConnections: boolean;
};

function isManagedCloud(host: string): boolean {
  return (
    host === "cloud.trigger.dev" ||
    host === "test-cloud.trigger.dev" ||
    host === "internal.trigger.dev" ||
    process.env.CLOUD_ENV === "development"
  );
}

function hasPrivateConnections(host: string): boolean {
  if (env.PRIVATE_CONNECTIONS_ENABLED === "1") {
    return isManagedCloud(host);
  }
  return false;
}

function featuresForHost(host: string): TriggerFeatures {
  return {
    isManagedCloud: isManagedCloud(host),
    hasPrivateConnections: hasPrivateConnections(host),
  };
}

export function featuresForRequest(request: Request): TriggerFeatures {
  const url = requestUrl(request);
  return featuresForUrl(url);
}

export function featuresForUrl(url: URL): TriggerFeatures {
  return featuresForHost(url.host);
}
