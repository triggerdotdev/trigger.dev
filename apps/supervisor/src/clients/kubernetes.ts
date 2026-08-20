import * as k8s from "@kubernetes/client-node";
import type { Informer, KubernetesObject, ListPromise } from "@kubernetes/client-node";
import { assertExhaustive } from "@trigger.dev/core/utils";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";

const RUNTIME_ENV = process.env.KUBERNETES_PORT ? "kubernetes" : "local";

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
 * createPodCountFetcher sizes a namespace's pod collection with a single `limit=1`
 * list: one pod transferred, no informer, no watch cache.
 *
 * This is an ESTIMATE, not an exact count. Kubernetes documents `remainingItemCount`
 * as intended for estimating collection size and reserves the right not to set it or
 * make it exact. Counting exactly would mean paginating the whole collection, which is
 * what this deliberately avoids. Treat the value as a tight estimate from a quorum read
 * at request time, and set thresholds with that in mind.
 *
 * Two request-shape constraints, both load-bearing. A label or field selector makes
 * the apiserver omit `remainingItemCount` entirely, and setting `resourceVersion`
 * serves a cached count instead of a quorum read - so neither is passed.
 */
export function createPodCountFetcher(
  api: K8sApi,
  namespace: string,
  timeoutMs: number
): () => Promise<number> {
  const serverTimeoutSeconds = Math.max(1, Math.floor(timeoutMs / 1000));
  let pending: Promise<unknown> | undefined;

  return async () => {
    if (pending) {
      throw new Error("pod count list still in flight from a previous tick");
    }

    const request = api.core.listNamespacedPod({
      namespace,
      limit: 1,
      timeoutSeconds: serverTimeoutSeconds,
    });

    pending = request
      .catch(() => {})
      .finally(() => {
        pending = undefined;
      });

    return podCountFromList(await withTimeout(request, timeoutMs, "pod count list"));
  };
}

/**
 * podCountFromList turns a `limit=1` pod list into a population estimate.
 *
 * `remainingItemCount` is only set when the list is truncated, so `_continue` is the
 * truncation signal: absent means the returned page is the whole collection and its
 * length is exact. When truncated the total leans on `remainingItemCount`, which is
 * documented as an estimate - so the result is an estimate too. Truncated without a
 * usable count is unknowable, so it throws rather than returning a low number the
 * caller would act on.
 */
export function podCountFromList(list: {
  items: unknown[];
  metadata?: { _continue?: string; remainingItemCount?: number };
}): number {
  if (!list.metadata?._continue) {
    return list.items.length;
  }

  const remaining = list.metadata.remainingItemCount;
  if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0) {
    throw new Error("pod list truncated but remainingItemCount absent or invalid");
  }

  return list.items.length + remaining;
}

/**
 * withTimeout rejects if `promise` outlives `timeoutMs`, so a hung request cannot
 * freeze the caller. It cannot cancel: the k8s client threads no AbortSignal through to
 * fetch, so an abandoned request keeps running. Callers must therefore also bound the
 * request server-side (`timeoutSeconds`) and refuse to start a second one while the
 * first is pending, or a blackholed connection accumulates one socket per attempt.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
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
