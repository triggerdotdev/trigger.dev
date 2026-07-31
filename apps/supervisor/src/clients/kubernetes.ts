import * as k8s from "@kubernetes/client-node";
import type { Informer, KubernetesObject, ListPromise } from "@kubernetes/client-node";
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
 * createPodCountFetcher counts pod objects in a namespace with a single `limit=1`
 * list: one pod transferred, no informer, no watch cache. Population is
 * `remainingItemCount + items.length`.
 *
 * Two request-shape constraints, both load-bearing. A label or field selector makes
 * the apiserver omit `remainingItemCount` entirely, and setting `resourceVersion`
 * serves a cached count instead of a quorum read - so neither is passed.
 *
 * `remainingItemCount` is only set when the list is truncated, so `_continue` is the
 * truncation signal: absent means the returned page is the whole collection.
 */
export function createPodCountFetcher(
  api: K8sApi,
  namespace: string,
  timeoutMs: number
): () => Promise<number> {
  const serverTimeoutSeconds = Math.max(1, Math.floor(timeoutMs / 1000));

  return async () => {
    const list = await withTimeout(
      api.core.listNamespacedPod({
        namespace,
        limit: 1,
        timeoutSeconds: serverTimeoutSeconds,
      }),
      timeoutMs,
      "pod count list"
    );

    if (!list.metadata?._continue) {
      return list.items.length; // not truncated, so this is all of them
    }

    const remaining = list.metadata.remainingItemCount;
    if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0) {
      throw new Error("pod list truncated but remainingItemCount absent or invalid");
    }

    return list.items.length + remaining;
  };
}

/**
 * withTimeout rejects if `promise` outlives `timeoutMs`, so a hung request cannot
 * freeze the caller. A backstop only: the k8s client threads no AbortSignal through
 * to fetch, so callers must also bound the request server-side (`timeoutSeconds`),
 * or an abandoned request would stay open. The timer is cleared either way.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref();
  });

  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
