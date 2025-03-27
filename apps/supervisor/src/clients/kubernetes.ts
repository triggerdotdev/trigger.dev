import * as k8s from "@kubernetes/client-node";
import { Informer } from "@kubernetes/client-node";
import { ListPromise } from "@kubernetes/client-node";
import { KubernetesObject } from "@kubernetes/client-node";
import { assertExhaustive } from "@trigger.dev/core/utils";

export const RUNTIME_ENV = process.env.KUBERNETES_PORT ? "kubernetes" : "local";

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
  console.log("getKubeConfig()", { RUNTIME_ENV });

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
