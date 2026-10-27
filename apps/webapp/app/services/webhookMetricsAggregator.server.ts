import {
  createCache,
  createLRUMemoryStore,
  DefaultStatefulContext,
  Namespace,
} from "@internal/cache";
import type { WebhookEngineMetricsHooks } from "@internal/webhook-engine";
import {
  createMetricsAggregator,
  type MetricsAggregatorOptions,
  type MetricUpdate,
} from "./metricsAggregator.server";

const WEBHOOK_METRIC_NAMES = {
  waitersLive: "webhook.waiters.live",
  waitersLimitEnv: "webhook.waiters.limit.env",
  waitersRefused: "webhook.waiters.refused",
  processingInFlight: "webhook.processing.in_flight",
  processingLimit: "webhook.processing.limit",
  ingressAllowed: "webhook.ingress.allowed",
  ingressDenied: "webhook.ingress.denied",
  ingressLimitTokens: "webhook.ingress.limit.tokens",
  ingressRemainingMin: "webhook.ingress.remaining_min",
} as const;

export type WebhookMetricsTenant = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

/**
 * Cached environment → tenant lookup: fresh for 5 minutes, then served stale for up to another 5.
 * A missing environment is cached as null.
 */
export function createWebhookMetricsTenantLookup(
  load: (environmentId: string) => Promise<WebhookMetricsTenant | null>
): (environmentId: string) => Promise<WebhookMetricsTenant | null> {
  const cache = createCache({
    tenants: new Namespace<WebhookMetricsTenant | null>(new DefaultStatefulContext(), {
      stores: [createLRUMemoryStore(10_000)],
      fresh: 5 * 60_000,
      stale: 10 * 60_000,
    }),
  });
  return async (environmentId) => {
    const result = await cache.tenants.swr(environmentId, () => load(environmentId));
    if (result.err) throw result.err;
    return result.val ?? null;
  };
}

type WebhookIngressScope = "endpoint" | "env" | "body";

type WebhookIngressObservation = {
  opaqueId: string;
  success: boolean;
  tokens?: number;
  remaining?: number;
};

type WebhookMetricsAggregatorOptions = Omit<MetricsAggregatorOptions<WebhookMetricsTenant>, "name">;

export function createWebhookMetricsAggregator(options: WebhookMetricsAggregatorOptions) {
  const metrics = createMetricsAggregator({ ...options, name: "webhook metrics" });

  return {
    waiterCreated: (tenant: WebhookMetricsTenant, liveCount: number, limit: number) =>
      metrics.record(tenant, [
        { name: WEBHOOK_METRIC_NAMES.waitersLive, reducer: "max", value: liveCount },
        { name: WEBHOOK_METRIC_NAMES.waitersLimitEnv, reducer: "last", value: limit },
      ]),
    waiterReleased: (tenant: WebhookMetricsTenant, liveCount: number) =>
      metrics.record(tenant, [
        { name: WEBHOOK_METRIC_NAMES.waitersLive, reducer: "max", value: liveCount },
      ]),
    waiterRefused: (tenant: WebhookMetricsTenant, reason: string) =>
      metrics.count(tenant, WEBHOOK_METRIC_NAMES.waitersRefused, 1, { attributes: { reason } }),
    processing: (tenant: WebhookMetricsTenant, inFlight: number, limit: number) =>
      metrics.record(tenant, [
        { name: WEBHOOK_METRIC_NAMES.processingInFlight, reducer: "max", value: inFlight },
        { name: WEBHOOK_METRIC_NAMES.processingLimit, reducer: "last", value: limit },
      ]),
    ingressAllowed: (tenant: WebhookMetricsTenant, opaqueId: string) =>
      metrics.record(
        tenant,
        [opaqueId, ""].map((subject) => ({
          name: WEBHOOK_METRIC_NAMES.ingressAllowed,
          reducer: "sum",
          value: 1,
          subject,
        }))
      ),
    ingress: (
      tenant: WebhookMetricsTenant,
      scope: WebhookIngressScope,
      observation: WebhookIngressObservation
    ) => {
      const updates = ingressUpdates(scope, observation);
      if (updates.length > 0) metrics.record(tenant, updates);
    },
    flush: metrics.flush,
    start: metrics.start,
  };
}

export type WebhookMetricsAggregator = ReturnType<typeof createWebhookMetricsAggregator>;

type WithWebhookMetrics = (
  environmentId: string,
  record: (metrics: WebhookMetricsAggregator, tenant: WebhookMetricsTenant) => void
) => void;

/** Translates the engine's hooks into aggregator calls for the environment's tenant. */
export function webhookMetricsHooks(withMetrics: WithWebhookMetrics): WebhookEngineMetricsHooks {
  return {
    onWaiterCreated: ({ environmentId }, liveCount, limit) =>
      withMetrics(environmentId, (metrics, tenant) =>
        metrics.waiterCreated(tenant, liveCount, limit)
      ),
    onWaiterRefused: ({ environmentId }, reason) =>
      withMetrics(environmentId, (metrics, tenant) => metrics.waiterRefused(tenant, reason)),
    onWaiterReleased: ({ environmentId }, liveCount) =>
      withMetrics(environmentId, (metrics, tenant) => metrics.waiterReleased(tenant, liveCount)),
    onProcessing: ({ environmentId }, inFlight, limit) =>
      withMetrics(environmentId, (metrics, tenant) => metrics.processing(tenant, inFlight, limit)),
  };
}

/** Denials roll up to the environment row; limit and remaining stay on their own subject. */
function ingressUpdates(
  scope: WebhookIngressScope,
  observation: WebhookIngressObservation
): MetricUpdate[] {
  const attributes = { scope };
  const subject = scope === "endpoint" ? observation.opaqueId : "";
  const deniedSubjects = observation.success ? [] : scope === "endpoint" ? [subject, ""] : [""];
  const remaining =
    observation.remaining === undefined ? undefined : Math.max(0, observation.remaining);
  const gauges: [string, MetricUpdate["reducer"], number | undefined][] = [
    [WEBHOOK_METRIC_NAMES.ingressLimitTokens, "last", observation.tokens],
    [WEBHOOK_METRIC_NAMES.ingressRemainingMin, "min", remaining],
  ];
  return [
    ...deniedSubjects.map((denied) => ({
      name: WEBHOOK_METRIC_NAMES.ingressDenied,
      reducer: "sum" as const,
      value: 1,
      subject: denied,
      attributes,
    })),
    ...gauges.flatMap(([name, reducer, value]) =>
      value === undefined ? [] : [{ name, reducer, value, subject, attributes }]
    ),
  ];
}
