import { env } from "./env.server";
import { requestUrl } from "./utils/requestUrl.server";

export type TriggerFeatures = {
  isManagedCloud: boolean;
  hasPrivateConnections: boolean;
  queueMetricsQueryTables: boolean;
};

const MANAGED_CLOUD_HOSTS = ["cloud.trigger.dev", "test-cloud.trigger.dev", "internal.trigger.dev"];

const publicAppHost = env.PUBLIC_APP_ORIGIN ? new URL(env.PUBLIC_APP_ORIGIN).host : undefined;

function isManagedCloud(host: string): boolean {
  return (
    MANAGED_CLOUD_HOSTS.includes(host) ||
    (publicAppHost !== undefined && MANAGED_CLOUD_HOSTS.includes(publicAppHost)) ||
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
    queueMetricsQueryTables: env.QUEUE_METRICS_QUERY_TABLES_VISIBLE === "1",
  };
}

export function featuresForRequest(request: Request): TriggerFeatures {
  const url = requestUrl(request);
  return featuresForUrl(url);
}

export function featuresForUrl(url: URL): TriggerFeatures {
  return featuresForHost(url.host);
}
