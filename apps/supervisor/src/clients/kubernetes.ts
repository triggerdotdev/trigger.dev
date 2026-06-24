import * as k8s from "@kubernetes/client-node";
import { Informer } from "@kubernetes/client-node";
import { ListPromise } from "@kubernetes/client-node";
import { KubernetesObject } from "@kubernetes/client-node";
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
export function createApiserverMetricsFetcher(): () => Promise<string> {
  const kubeConfig = getKubeConfig();

  return async () => {
    const cluster = kubeConfig.getCurrentCluster();
    if (!cluster) {
      throw new Error("no current cluster in kubeconfig");
    }
    const requestInit = await kubeConfig.applyToFetchOptions({ method: "GET" });
    // node-fetch vs DOM RequestInit: structurally compatible, declaration-only mismatch
    const response = await fetch(`${cluster.server}/metrics`, requestInit as unknown as RequestInit);
    if (!response.ok) {
      throw new Error(`apiserver /metrics scrape failed: ${response.status}`);
    }
    return response.text();
  };
}
