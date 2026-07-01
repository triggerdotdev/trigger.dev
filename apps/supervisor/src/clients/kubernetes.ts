import * as https from "node:https";
import * as k8s from "@kubernetes/client-node";
import type { Informer, ListPromise, KubernetesObject } from "@kubernetes/client-node";
import { assertExhaustive } from "@trigger.dev/core/utils";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";

export const RUNTIME_ENV = process.env.KUBERNETES_PORT ? "kubernetes" : "local";

const logger = new SimpleStructuredLogger("kubernetes-client");

export function createK8sApi() {
  const kubeConfig = getKubeConfig();

  function makeInformer<T extends KubernetesObject>(
    path: string,
    listPromiseFn: ListPromise<T>,
    labelSelector?: string,
    fieldSelector?: string
  ): Informer<T> {
    return k8s.makeInformer(kubeConfig, path, listPromiseFn, labelSelector, fieldSelector);
  }

  const api = {
    core: kubeConfig.makeApiClient(k8s.CoreV1Api),
    batch: kubeConfig.makeApiClient(k8s.BatchV1Api),
    apps: kubeConfig.makeApiClient(k8s.AppsV1Api),
    makeInformer,
  };

  return api;
}

export type K8sApi = ReturnType<typeof createK8sApi>;

function getKubeConfig() {
  logger.debug("getKubeConfig()", { RUNTIME_ENV });

  const kubeConfig = new k8s.KubeConfig();

  switch (RUNTIME_ENV) {
    case "local":
      kubeConfig.loadFromDefault();
      break;
    case "kubernetes":
      kubeConfig.loadFromCluster();
      break;
    default:
      assertExhaustive(RUNTIME_ENV);
  }

  return kubeConfig;
}

export { k8s };

/**
 * Builds a function that scrapes the apiserver's Prometheus /metrics endpoint.
 * One lightweight aggregate read - not a pod listing. Requires the service
 * account to be granted GET on the /metrics non-resource URL.
 */
export function createApiserverMetricsFetcher(timeoutMs: number): () => Promise<string> {
  const kubeConfig = getKubeConfig();

  return async () => {
    const cluster = kubeConfig.getCurrentCluster();
    if (!cluster) {
      throw new Error("no current cluster in kubeconfig");
    }
    const url = new URL(`${cluster.server}/metrics`);
    const opts: https.RequestOptions = {
      method: "GET",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
    };
    // applyToHTTPSOptions sets the cluster CA, client cert/key, and auth headers
    // (incl. exec plugins) on the request - so TLS verifies against the cluster
    // CA, not the system store. The fetch-options path attaches the CA as an
    // https.Agent, which global fetch (undici) ignores.
    await kubeConfig.applyToHTTPSOptions(opts);

    return new Promise<string>((resolve, reject) => {
      const req = https.request(opts, (res) => {
        const status = res.statusCode ?? 0;
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (status >= 200 && status < 300) {
            resolve(body);
          } else {
            reject(new Error(`apiserver /metrics scrape failed: ${status}`));
          }
        });
      });
      // Without this a hung connect/TLS/read never settles, and the monitor's
      // refreshInFlight guard would freeze the source (silent fail-open).
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`apiserver /metrics scrape timed out after ${timeoutMs}ms`));
      });
      req.on("error", reject);
      req.end();
    });
  };
}
